import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());

// Servir le frontend (public/index.html)
app.use(express.static(path.join(__dirname, "public")));

// Mémoire simple : dernière vraie question par IP (pour "rep à ma question")
const lastQuestionByIp = {};

// ================== HELPERS TEXTE / FILTRAGE ==================

function normalizeText(str = "") {
  return String(str || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

// Extraction très simple de mots-clés utiles depuis la question
function extractKeywords(question) {
  const q = normalizeText(question);
  const stopwords = [
    "le", "la", "les", "un", "une", "des", "de", "du", "au", "aux", "en", "et",
    "ou", "a", "à", "est", "c", "ce", "ces", "pour", "avec", "sur", "dans",
    "comment", "combien", "quoi", "quel", "quelle", "quels", "quelles",
    "qui", "que", "quand", "ou", "où"
  ];
  const tokens = q.split(/[^a-z0-9]+/).filter(Boolean);
  return tokens.filter(t => t.length > 2 && !stopwords.includes(t));
}

// Détection si la question parle de prix / abonnement
function isPriceQuestion(question) {
  const q = normalizeText(question);
  return /prix|cout|coût|abonnement|abo|tarif|combien ca coute|combien ça coûte|combien coute|combien coûte|coute combien|coûte combien/i.test(
    q
  );
}

// Détection si la question parle d'un service / produit
function isProductOrServiceQuestion(question) {
  const q = normalizeText(question);
  return /amazon|prime|netflix|spotify|disney\+|disney plus|apple tv|canal\+|canal plus|iphone|samsung|android|macbook|pc gamer|voiture|pneu|pneus|ordinateur|console|ps5|xbox/i.test(
    q
  );
}

// Détection d'un sujet "people / poste" (président, PDG, etc.)
function isPersonInRoleQuestion(question) {
  const q = normalizeText(question);
  return /president|président|pdg|ceo|premier ministre|roi|reine|gouverneur|maire|dirige|chef d.etat|chef d etat/i.test(
    q
  );
}

// Scoring agressif des résultats Brave
function scoreWebResult(question, result, currentYear) {
  const qNorm = normalizeText(question);
  const qKeywords = extractKeywords(question);
  const text = normalizeText(
    (result.title || "") +
      " " +
      (result.description || result.snippet || "") +
      " " +
      (result.url || "")
  );

  let score = 0;

  // 1) Overlap de mots-clés
  let overlap = 0;
  for (const kw of qKeywords) {
    if (kw && text.includes(kw)) {
      overlap += 1;
      score += 2;
    }
  }
  if (overlap === 0) {
    score -= 4;
  }

  // 2) Bonus selon type de question
  const qIsPrice = isPriceQuestion(question);
  const qIsProd = isProductOrServiceQuestion(question);
  const qIsPerson = isPersonInRoleQuestion(question);

  if (qIsProd && /amazon|prime|netflix|spotify|disney\+|disney plus|iphone|samsung|macbook|ps5|xbox|pneu|pneus/.test(text)) {
    score += 4;
  }

  if (qIsPrice && /prix|tarif|abonnement|subscription|€/i.test(text)) {
    score += 3;
  }

  if (qIsPerson && /president|président|pdg|ceo|premier ministre|roi|reine|gouverneur|maire/i.test(text)) {
    score += 3;
  }

  // 3) Pénalités thématiques génériques si la question ne parle pas de ça
  const questionIsEntertainment = /film|série|serie|netflix|prime video|primevideo|disney\+|disney plus|anime|manga/.test(qNorm);
  const textIsEntertainment = /film|série|serie|netflix|prime video|primevideo|disney\+|disney plus|anime|manga/.test(text);

  if (!questionIsEntertainment && textIsEntertainment) {
    score -= 5;
  }

  const questionIsRealEstate = /immobilier|loyer|appartement|maison|m2|mètre carré|m2/.test(qNorm);
  const textIsRealEstate = /immobilier|real estate|foncier|fonciere|foncière|loyer/.test(text);

  if (!questionIsRealEstate && textIsRealEstate) {
    score -= 5;
  }

  const questionIsSports = /foot|football|basket|nba|ligue 1|ufc|mma|tennis|match/.test(qNorm);
  const textIsSports = /foot|football|basket|nba|ligue 1|ufc|mma|tennis|match|score/.test(text);

  if (!questionIsSports && textIsSports) {
    score -= 4;
  }

  const questionIsPolitics = /élection|election|politique|présidentielle|gouvernement/.test(qNorm);
  const textIsPolitics = /élection|election|politique|présidentielle|gouvernement|vote|scrutin/.test(text);

  if (!questionIsPolitics && textIsPolitics) {
    score -= 4;
  }

  // 4) Gestion des années : on pénalise les années très loin dans le futur
  const years = text.match(/20\d{2}/g) || [];
  for (const yStr of years) {
    const y = parseInt(yStr, 10);
    if (y > currentYear + 1) {
      score -= 3;
    }
  }

  // 5) Bonus sources un peu plus fiables
  if (/(wikipedia\.org)|(gouv\.fr)|(service-public\.fr)|(amazon\.)|(netflix\.com)|(spotify\.com)/.test(text)) {
    score += 2;
  }

  return score;
}

function filterWebResults(question, results, currentYear) {
  if (!results || results.length === 0) return [];

  const scored = results.map(r => ({
    result: r,
    score: scoreWebResult(question, r, currentYear)
  }));

  scored.sort((a, b) => b.score - a.score);

  const bestScore = scored[0]?.score ?? -999;

  // Si le meilleur score est trop faible, on considère qu'on n'a rien de fiable
  if (bestScore < 4) {
    return [];
  }

  const filtered = scored
    .filter(s => s.score >= bestScore - 2 && s.score > 0)
    .map(s => s.result);

  return filtered;
}

// ================== SYSTEM PROMPT (avec règles + date) ==================
function buildSystemPrompt(currentDate) {
  return `
Tu es TDIA, une IA généraliste pensée pour les personnes TDAH, créée par "Esprit TDAH".
Tu ne donnes jamais de détails techniques sur les modèles ou ton architecture interne.

--------------------------------------
DATE ACTUELLE
--------------------------------------
- Nous sommes le ${currentDate}.
- C'est la date exacte du jour. Tu ne la contredis jamais.
- Quand l'utilisateur parle de "maintenant", "actuellement", "en ce moment", tu te bases sur cette date.
- Tes connaissances internes s'arrêtent globalement fin 2023,
  MAIS tu ne réponds JAMAIS comme si tu vivais en 2023 : tu parles toujours depuis la date actuelle.
- Si tu utilises une donnée datée (par exemple un prix trouvé en 2023),
  tu précises clairement que c'est la dernière info fiable, et que cela peut avoir évolué.

--------------------------------------
RÈGLE FUTUR / ANNONCES
--------------------------------------
- Tu ne prédis jamais le futur par toi-même.
- Tu n'inventes aucun événement futur (politique, sportif, économique, etc.).
- Tu peux mentionner des événements prévus (projets, annonces officielles, compétitions programmées)
  UNIQUEMENT s'ils apparaissent dans les résultats web.
- Dans ce cas, tu précises clairement que ce sont des prévisions / projets / annonces, pas des certitudes.
- Si aucune info fiable n'existe pour le futur, tu dis que tu n'as pas d'information fiable, plutôt que d'inventer.

--------------------------------------
MÊME SUJET QUE LA QUESTION
--------------------------------------
- Ta réponse doit porter sur le même sujet explicite que la question :
  même produit, même service, même personne, même thème.
- Exemple : si l'utilisateur demande le prix de l'abonnement Amazon Prime,
  tu ne pars pas sur Prime Video, les films, l'immobilier ou d'autres sujets.
- Si tu te rends compte que ta réponse part sur un autre sujet que la question,
  tu arrêtes et tu le dis ("je suis sorti du sujet, je reformule").
- Tu restes focalisé sur la demande principale, sans rajouter des thèmes parasites.

--------------------------------------
UTILISATION DES RÉSULTATS WEB
--------------------------------------
- Le serveur peut t'envoyer un résumé de résultats web filtrés.
- Tu utilises ces résultats comme base principale pour :
  actualité, prix, abonnements, personnes en poste, lois, etc.
- Tu synthétises, tu vulgarises, tu ne recopie pas les liens.
- Si les sources sont floues ou contradictoires, tu l'expliques clairement.
- Si aucune info web fiable n'est trouvée, tu ne "complètes" pas avec ton imagination :
  tu dis simplement que tu n'as pas d'info fiable.

--------------------------------------
PRIX, CHIFFRES, DONNÉES NUMÉRIQUES
--------------------------------------
- Tu ne devines jamais un prix ou un chiffre.
- Tu t'appuies sur les résultats web quand ils existent.
- Si les sources donnent plusieurs prix, tu peux donner une fourchette ou le prix le plus courant,
  en précisant que cela peut varier selon les promotions, les pays, etc.
- Si tu n'as rien de fiable, tu le dis clairement ("je n'ai pas de prix fiable à jour, vérifie sur le site officiel").
- Tu fais attention à la date des informations (ex: "dernier prix trouvé en 2023").

--------------------------------------
COHÉRENCE / VÉRIFICATION
--------------------------------------
- Avant de répondre, tu vérifies mentalement :
  1) Est-ce cohérent avec la question ?
  2) Est-ce cohérent avec la date actuelle ?
  3) Est-ce cohérent avec les résultats web fournis ?
- Si ta réponse ne parle pas du même sujet que la question, tu la corriges.
- Si tu n'es pas sûr, tu privilégies "je ne sais pas" plutôt que d'inventer.

--------------------------------------
STYLE TDAH-FRIENDLY
--------------------------------------
- Langage simple, phrases courtes.
- Tu évites les gros pavés : tu préfères les petits paragraphes et les listes.
- Tu peux utiliser quelques émojis pour rythmer, sans en abuser.
- Tu mets la réponse clé en premier, puis tu détailles en 3 à 5 points maximum.
- Si la question est floue, tu proposes 2 ou 3 options de clarification, pas plus.

--------------------------------------
CONTEXTE / "REP À MA QUESTION"
--------------------------------------
- Le serveur peut te signaler que l'utilisateur veut que tu répondes à sa question précédente
  ("rep à ma question", "réponds à celle d'avant"...).
- Dans ce cas, tu te concentres sur la DERNIÈRE vraie question enregistrée, pas sur le message flou.
- Tu restes focalisé sur l'intention la plus récente de l'utilisateur.

--------------------------------------
OBJECTIF
--------------------------------------
- Tu réponds comme une IA généraliste compétente,
  mais ultra claire, simple et digeste pour un esprit TDAH.
`;
}

// ================== BRAVE SEARCH (WEB) ==================
async function braveSearch(query) {
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(
    query
  )}&count=5`;

  const r = await fetch(url, {
    method: "GET",
    headers: {
      "X-Subscription-Token": process.env.BRAVE_API_KEY
    }
  });

  if (!r.ok) {
    console.error("Brave error:", await r.text());
    return null;
  }

  const data = await r.json();
  return data.web?.results || [];
}

// ================== ROUTE /chat ==================
app.post("/chat", async (req, res) => {
  const { message } = req.body || {};
  if (!message) {
    return res.status(400).json({ error: "message manquant" });
  }

  const rawMessage = String(message);
  const userIp = req.ip || "unknown_ip";

  // Détection des messages du type "rep à ma question"
  const followUpRegex =
    /(rep à ma question|rep a ma question|réponds à ma question|reponds a ma question|réponds à la question précédente|réponds à la question d’avant|réponds-moi|reponds moi|réponds y|réponds-y)$/i;

  const isFollowUp = followUpRegex.test(rawMessage.trim());

  let effectiveQuestion = rawMessage;
  if (isFollowUp && lastQuestionByIp[userIp]) {
    effectiveQuestion = lastQuestionByIp[userIp];
  }

  let finalUserMessage = effectiveQuestion;

  const currentDate = new Date().toLocaleDateString("fr-FR", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric"
  });
  const currentYear = new Date().getFullYear();

  const qNorm = normalizeText(effectiveQuestion);

  const isFutureQuestion =
    /en 20(2[6-9]|3\d)|dans \d+ ans|année prochaine|l'année prochaine|dans le futur/i.test(
      qNorm
    );

  const forceSearchPerson = isPersonInRoleQuestion(effectiveQuestion);
  const forceSearchPrice = isPriceQuestion(effectiveQuestion);
  const forceSearchProduct = isProductOrServiceQuestion(effectiveQuestion);

  const baseSearchTrigger =
    /2024|2025|actu|actualité|recent|récemment|dernier|dernière|news|résultat|score|aujourd'hui|hier|tweet|twitter|x\.com|élections?|guerre|conflit|nouveau|mise à jour|update|actualité/i.test(
      qNorm
    );

  let needSearch =
    !isFutureQuestion &&
    (forceSearchPerson || forceSearchPrice || forceSearchProduct || baseSearchTrigger);

  if (needSearch) {
    try {
      const query = `${effectiveQuestion} actuel ${currentYear}`;
      const results = await braveSearch(query);

      const filtered = filterWebResults(effectiveQuestion, results || [], currentYear);

      if (filtered && filtered.length > 0) {
        const top = filtered.slice(0, 3);

        const summaryLines = top.map(r => {
          const title = r.title || "";
          const url = r.url || "";
          const desc = r.description || r.snippet || "";
          return `• ${title}\n  ${desc}\n  (${url})`;
        });

        const summaryBlock = summaryLines.join("\n\n");

        finalUserMessage = `
Voici la question de l'utilisateur :
"${effectiveQuestion}"

Voici des résultats web récents (titres, descriptions, URLs) filtrés pour ce sujet :
${summaryBlock}

En te basant en priorité sur ces informations RÉCENTES et PERTINENTES :
- Donne une réponse claire et structurée, adaptée à une personne TDAH.
- Reste strictement sur le même sujet que la question.
- Synthétise ce qui est utile, ne recopie pas les liens.
- Si les sources sont floues ou contradictoires, signale-le.
`;
      } else {
        finalUserMessage = `
La question de l'utilisateur est :
"${effectiveQuestion}"

Aucune information web vraiment pertinente ou fiable n'a été trouvée pour ce sujet.
Tu ne dois pas inventer de faits, de chiffres ou d'événements.
Explique simplement que tu n'as pas d'information fiable à jour sur ce point,
et propose à l'utilisateur de vérifier sur une source officielle si nécessaire.
`;
      }
    } catch (err) {
      console.error("Erreur Brave (ignorée, on continue sans web) :", err);
    }
  }

  try {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: process.env.MODEL, // sur Render : MODEL = gpt-4o
        temperature: 0.35,
        messages: [
          { role: "system", content: buildSystemPrompt(currentDate) },
          { role: "user", content: finalUserMessage }
        ],
        max_tokens: 700
      })
    });

    if (!r.ok) {
      const t = await r.text();
      return res.status(500).json({ error: "openai_error", detail: t });
    }

    const j = await r.json();
    const answer =
      j.choices?.[0]?.message?.content || "Désolé, je n'ai pas pu générer de réponse.";

    if (!isFollowUp) {
      lastQuestionByIp[userIp] = effectiveQuestion;
    }

    res.json({ reply: answer, usedSearch: needSearch });
  } catch (e) {
    console.error("Erreur serveur :", e);
    res.status(500).json({ error: "server_error", detail: String(e) });
  }
});

// Catch-all
app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const port = process.env.PORT || 3000;
app.listen(port, () =>
  console.log("TDIA server on http://localhost:" + port)
);
