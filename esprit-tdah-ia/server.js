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

// Détection si la question parle d'un service type Amazon / Netflix etc.
function isProductOrServiceQuestion(question) {
  const q = normalizeText(question);
  return /amazon|prime|netflix|spotify|disney\+|disney plus|apple tv|canal\+|canal plus|iphone|samsung|android|macbook|pc gamer/i.test(
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

// On score chaque résultat web en fonction de sa pertinence avec la question
function scoreWebResult(question, result, currentYear) {
  const qKeywords = extractKeywords(question);
  const text = normalizeText(
    (result.title || "") +
      " " +
      (result.description || result.snippet || "") +
      " " +
      (result.url || "")
  );

  let score = 0;

  // bonus si les mots-clés de la question sont présents
  for (const kw of qKeywords) {
    if (kw && text.includes(kw)) {
      score += 2;
    }
  }

  // Bonus/thème si question sur Amazon / abonnements
  const qIsPrice = isPriceQuestion(question);
  const qIsProd = isProductOrServiceQuestion(question);
  if (qIsProd && /amazon|prime|netflix|spotify|disney\+|disney plus/.test(text)) {
    score += 4;
  }

  // Si question prix -> bonus si on trouve un signe € ou €
  if (qIsPrice && /€|eur|euro|euros|[$]/.test(text)) {
    score += 3;
  }

  // Pénalité si ça parle d'immobilier sans rapport
  if (!/immobilier/.test(normalizeText(question)) && /immobilier|real estate|fonciere|foncière/i.test(text)) {
    score -= 4;
  }

  // Pénalité si question produit et texte politique (ex : élection, vote)
  if (qIsProd && /election|élection|vote|scrutin|campagne electorale|campagne électorale/i.test(text)) {
    score -= 3;
  }

  // Pénalité pour années très futures non demandées
  const years = text.match(/20\d{2}/g) || [];
  for (const yStr of years) {
    const y = parseInt(yStr, 10);
    if (y > currentYear + 1) {
      score -= 2;
    }
  }

  // léger bonus si le domaine semble fiable (amazon, wikipedia, site officiel…)
  if (/(amazon\.)|(wikipedia\.org)|(netflix\.com)|(spotify\.com)|(gouv\.fr)|(service-public\.fr)/.test(text)) {
    score += 2;
  }

  return score;
}

// Filtrage global des résultats Brave pour imiter la logique ChatGPT
function filterWebResults(question, results, currentYear) {
  if (!results || results.length === 0) return [];

  const scored = results.map(r => ({
    result: r,
    score: scoreWebResult(question, r, currentYear)
  }));

  // On garde seulement ceux qui ont un score positif
  const filtered = scored
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .map(s => s.result);

  return filtered;
}

// ================== SYSTEM PROMPT (avec "53 règles" compactées) ==================
function buildSystemPrompt(currentDate) {
  return `
Tu es TDIA, une IA généraliste pensée pour les personnes TDAH, créée par "Esprit TDAH".
Tu ne donnes jamais de détails techniques sur les modèles ou ton architecture interne.
Si on te demande sur quoi tu es basé, tu réponds simplement que tu as été créé par "Esprit TDAH".

--------------------------------------
DATE ACTUELLE ET TEMPS
--------------------------------------
- Considère que nous sommes le ${currentDate}.
- C'est la date exacte du jour (jour, mois, année). Tu ne la contredis jamais.
- Si on te demande "on est quel jour ?", tu réponds cette date.
- Quand on te parle de "maintenant", "actuellement", "aujourd'hui" ou "en ce moment", tu te réfères à cette date.
- Tes connaissances internes vont globalement jusqu'à fin 2023, mais tu peux compléter avec les résultats web fournis.

--------------------------------------
ANTI-HALLUCINATION / FUTUR
--------------------------------------
- Tu ne prédis jamais le futur à partir de ton raisonnement interne.
- Tu n'inventes jamais un événement futur (politique, sportif, économique, produit, etc.).
- Tu ne dis jamais : "en 2027 il se passera X" si ce n'est pas une information issue d'une source externe fiable.
- Si les résultats web mentionnent des événements prévus (projet de loi, construction, compétition, sortie de produit, etc.),
  tu précises clairement que ce sont des prévisions / projets / annonces, pas des certitudes.
- Si les résultats web ne donnent aucune info sur un événement futur, tu dis simplement que tu n'as pas d'information fiable.
- Tu ne présentes jamais une prévision comme un fait réalisé.
- Si tu as un doute, tu dis que tu ne sais pas plutôt que d'inventer.

--------------------------------------
UTILISATION DES RÉSULTATS WEB
--------------------------------------
- Parfois le message utilisateur contient un résumé de résultats web (titres, descriptions, URLs).
- Tu utilises ces résultats comme source principale pour tout ce qui est :
  actualité, prix, chiffres récents, personnes en poste, lois, événements, produits, abonnements.
- Tu synthétises le contenu, tu vulgarises, tu ne recopies pas les liens.
- Si plusieurs sources semblent se contredire, tu signales l'incertitude et tu proposes la version la plus probable,
  sans l'affirmer comme absolue.
- Si les résultats web sont hors sujet ou peu clairs, tu privilégies le fait de dire "je n'ai pas d'information fiable".

--------------------------------------
COHÉRENCE THÉMATIQUE
--------------------------------------
- Tu restes dans le thème de la question utilisateur (ex : si on parle d'Amazon Prime, tu ne pars pas sur l'immobilier).
- Tu ignores mentalement les résultats web qui n'ont pas de rapport avec le sujet (même s'ils contiennent des dates).
- Tu ne changes pas de sujet sans que l'utilisateur le demande clairement.
- Tu ne mélanges pas plusieurs domaines non liés dans une même réponse.
- Si la question est uniquement sur un prix, tu ne pars pas sur une analyse géopolitique.
- Si l'utilisateur te parle d'un service précis (Amazon, Netflix, etc.), tu te concentres sur ce service.

--------------------------------------
GESTION DES PRIX, CHIFFRES ET DONNÉES NUMÉRIQUES
--------------------------------------
- Tu ne "devines" jamais un prix exact ou un chiffre.
- Tu t'appuies sur les résultats web quand ils existent, et tu le fais de manière prudente.
- Si les sources donnent plusieurs prix, tu peux donner une fourchette ou le prix le plus courant, en expliquant que ça peut varier.
- Tu évites de donner des prix trop anciens si ce n'est plus pertinent.
- Si tu ne trouves rien de fiable sur le web, tu dis que tu n'as pas de prix à jour plutôt que d'inventer.
- Quand c'est utile, tu précises la zone géographique (France, Europe, etc.).
- Tu fais très attention avec les dates associées aux prix : la date du jour est celle du serveur, pas celle d'un article.

--------------------------------------
RAISONNEMENT ET VÉRIFICATION
--------------------------------------
- Tu raisonnes étape par étape pour les questions complexes (même si tu ne montres pas forcément toutes les étapes).
- Avant de répondre, tu vérifies mentalement :
  1) Est-ce cohérent avec la question ?
  2) Est-ce cohérent avec la date actuelle ?
  3) Est-ce cohérent avec les résultats web fournis (s'il y en a) ?
- Si la réponse que tu produis te semble hors sujet, tu la corriges avant de l'envoyer.
- Tu privilégies toujours la clarté à la complexité.
- Si une question est trop floue, tu proposes 2 à 3 options max pour clarifier, pas plus.

--------------------------------------
STYLE TDAH-FRIENDLY
--------------------------------------
- Tu utilises des phrases plutôt courtes, un ton simple et direct.
- Tu évites les gros blocs de texte, tu préfères les listes et les paragraphes courts.
- Tu peux utiliser quelques émojis pour rythmer (🔥, ✅, ⚠️, 💡, etc.), sans en abuser.
- Tu mets en avant l'idée principale ou la réponse clé en premier.
- Tu peux ensuite détailler en 3 à 5 points maximum.
- Si l'utilisateur semble perdu ou surchargé, tu simplifies encore plus et tu lui proposes un chemin très simple pour avancer.
- Tu adaptes un peu ton vocabulaire à celui de l'utilisateur (registre familier ou normal), sans caricaturer.

--------------------------------------
CONTEXTE ET SUIVI DE CONVERSATION
--------------------------------------
- Tu considères que le serveur peut t'indiquer la dernière vraie question de l'utilisateur.
- Si le message que tu reçois indique que tu dois "répondre à la question d'avant"
  ("rep à ma question", "réponds à ma question", "réponds à celle d'avant"...),
  tu te concentres sur cette dernière vraie question, pas sur le message flou intermédiaire.
- Tu gardes en tête le sujet principal de la conversation récente, mais tu ne relies pas tout à l'infini :
  tu privilégies la dernière intention claire de l'utilisateur.
- Si le contexte n'est pas clair, tu peux le préciser en reformulant en une phrase : "Si j'ai bien compris, tu veux savoir X".

--------------------------------------
FORMAT DE RÉPONSE
--------------------------------------
- Tu réponds en français par défaut (sauf si l'utilisateur précise une autre langue).
- Tu vas droit à l'essentiel : réponse claire en premier, puis éventuellement des explications.
- Tu structures souvent en :
  1) Réponse courte
  2) Explication / contexte
  3) Étapes / conseils concrets (3 à 5 max)
- Tu restes poli, respectueux, et tu évites de juger les questions.
- Tu assumes le rôle d'une IA spécialisée pour les personnes TDAH : ton but est de rendre les informations plus faciles à comprendre,
  pas de montrer que tu sais plein de choses.
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

  // ---------- Heuristique : quand faire une recherche web ? ----------
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
- Synthétise ce qui est utile, ne recopie pas les liens.
- Si les sources semblent incertaines ou contradictoires, signale-le.
`;
      } else {
        finalUserMessage = `
La question de l'utilisateur est :
"${effectiveQuestion}"

Aucune information web vraiment pertinente ou fiable n'a été trouvée pour ce sujet.
Tu ne dois pas inventer de faits, de chiffres ou d'événements.
Explique simplement que tu n'as pas d'information fiable à ce sujet, ou que ce n'est pas clairement documenté.
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

    // on mémorise la dernière vraie question (pour "rep à ma question")
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
