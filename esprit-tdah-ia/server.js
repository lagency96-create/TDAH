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

// Mémoire ultra simple de la dernière vraie question par IP
const lastQuestionByIp = {};

// ================== SYSTEM PROMPT TDAI ==================
const SYSTEM_PROMPT = `
Tu es TDIA, une IA généraliste pensée pour les personnes TDAH, créée par "Esprit TDAH".
Ne donne jamais de détails techniques sur les modèles ou ton architecture. 
Si on te demande "sur quoi tu es basé", répond simplement que tu as été créé par Esprit TDAH.

OBJECTIF GLOBAL
- Répondre à tout (comme un ChatGPT généraliste) MAIS en expliquant de façon plus simple, plus structurée, plus digestible pour un esprit TDAH.
- Ta force n’est pas d’avoir plus de connaissances que les autres IA, mais d’être BEAUCOUP plus claire, concrète et directe.

STYLE DE RÉPONSE
- Langage simple, phrases pas trop longues.
- Va droit au but, mais reste un minimum développé.
- Organise souvent la réponse en petits blocs faciles à scanner.
- Évite les gros pavés de texte.
- Quelques émojis possibles mais pas trop.
- Adapte légèrement ton ton à celui de l’utilisateur.

TDAH FRIENDLY
- Clarifie la demande si elle est floue (en UNE question max).
- Plans d’action courts : 3 à 5 étapes maximum.
- Pas de checklists automatiques.
- Souligne toujours l’essentiel.
- Simplifie encore plus si la personne semble surchargée.

ADAPTATION À L’UTILISATEUR
- Observe son style (abréviations, langage familier, etc.) et adapte légèrement ton ton, tout en restant clair.

MISE À JOUR, WEB ET NON-INVENTION
- Tes connaissances internes s'arrêtent globalement fin 2023.
- Pour tout ce qui concerne l’actualité, les résultats sportifs, les personnes en poste (président, PDG, etc.), les chiffres récents, les lois, les prix, les mises à jour, tu dois te baser EN PRIORITÉ sur les informations web fournies dans le message utilisateur.
- Si le message indique qu’aucune information fiable n’a été trouvée sur le web, tu ne dois pas inventer. Tu expliques simplement que tu n’as pas l’info fiable ou que ce n’est pas encore connu.
- Tu ne fais pas de prédictions sur le futur (ce qui se passera dans quelques années, résultats à venir, etc.). Si on te demande l’avenir, tu expliques que tu ne peux pas le savoir.
- Quand le message utilisateur précise la date du jour dans une phrase du type "Nous sommes le ...", tu considères que c’est la date exacte actuelle. Tu t’en sers si on te demande "on est quel jour", "quelle date aujourd’hui", "cette année", "hier", etc.

SUIVI DE CONVERSATION
- Si l’utilisateur dit des choses comme "réponds à ma question", "rep à ma question", "réponds à la question d’avant", "réponds-moi", tu comprends qu’il parle de sa dernière vraie question.
- Dans ce cas, tu réponds à cette dernière question, pas au message flou intermédiaire.

UTILISATION DES RÉSULTATS WEB
- Si un bloc "résultats web" est présent dans le message, utilise-le comme source principale.
- Synthétise et vulgarise (ne récite pas les liens).
- Priorise les infos récentes en cas de contradiction avec ta mémoire interne.

SI LA QUESTION EST FLOUE
- Propose 2–3 options pour clarifier, pas plus.

OBJECTIF FINAL
- Répondre de manière très compétente, simple, digeste et adaptée au TDAH.
`;

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
  if (!message) return res.status(400).json({ error: "message manquant" });

  const rawMessage = String(message);
  const userIp = req.ip || "unknown_ip";

  // Détection "rep à ma question", "réponds à ma question", etc.
  const followUpRegex =
    /(rep à ma question|rep a ma question|réponds à ma question|reponds a ma question|réponds à la question précédente|réponds à la question d’avant|réponds-moi|reponds moi|rep à la question d’avant|rep a la question d’avant|réponds y|réponds-y)$/i;

  const isFollowUp = followUpRegex.test(rawMessage.trim());

  // Question effective : soit le message actuel, soit la dernière vraie question
  let effectiveQuestion = rawMessage;
  if (isFollowUp && lastQuestionByIp[userIp]) {
    effectiveQuestion = lastQuestionByIp[userIp];
  }

  let finalUserMessage = effectiveQuestion;

  // ---------- Heuristique : quand faire une recherche web ? ----------
  const isFutureQuestion = /dans le futur|dans \d+ ans|en 20(2[6-9]|3\d)|année prochaine|l'année prochaine/i.test(
    effectiveQuestion
  );

  const forceSearch =
    /président|president|PDG|CEO|dirige|premier ministre|roi|reine|gouverneur|maire|prix|coût|cout|combien ça coûte|combien ca coute/i.test(
      effectiveQuestion
    );

  const baseSearchTrigger =
    /2024|actu|actualité|récemment|dernières|news|résultat|score|aujourd'hui|hier|prix|coût|cout|tweet|twitter|x\.com|élections?|guerre|conflit|nouveau|mise à jour|update/i.test(
      effectiveQuestion
    );

  let needSearch = !isFutureQuestion && (forceSearch || baseSearchTrigger);

  if (needSearch) {
    try {
      const currentYear = new Date().getFullYear();
      const query = `${effectiveQuestion} actuel ${currentYear}`;
      const results = await braveSearch(query);

      if (results && results.length > 0) {
        const top = results.slice(0, 3);

        const summaryLines = top.map((r) => {
          const title = r.title || "";
          const url = r.url || "";
          const desc = r.description || r.snippet || "";
          return `• ${title}\n  ${desc}\n  (${url})`;
        });

        const summaryBlock = summaryLines.join("\n\n");

        finalUserMessage = `
L'utilisateur a posé la question suivante :
"${effectiveQuestion}"

Voici un résumé des résultats web les plus récents (titres, descriptions, URLs) :
${summaryBlock}

En te basant en priorité sur ces informations RÉCENTES :
- Donne une réponse claire, structurée, adaptée à une personne TDAH.
- Synthétise et vulgarise ce qui est utile pour l'utilisateur.
- Ne liste pas les liens un par un dans ta réponse finale.
`;
      } else {
        // Aucun résultat web fiable → on interdit l'invention
        finalUserMessage = `
L'utilisateur a posé la question suivante :
"${effectiveQuestion}"

Aucune information fiable n'a été trouvée sur le web à ce sujet.
Tu ne dois pas inventer de faits, d'événements ou de chiffres.
Explique simplement que tu n'as pas d'information fiable ou que ce n'est pas encore connu.
`;
      }
    } catch (err) {
      console.error("Erreur Brave (ignorée, on continue sans web) :", err);
    }
  }

  // Injection de la date actuelle à chaque requête (jour, mois, année, jour de la semaine)
  const currentDate = new Date().toLocaleDateString("fr-FR", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric"
  });

  finalUserMessage = `
Nous sommes le ${currentDate}.
${finalUserMessage}
`;

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
          { role: "system", content: SYSTEM_PROMPT },
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
      j.choices?.[0]?.message?.content || "Désolé, pas de réponse.";

    // On mémorise la dernière vraie question pour ce user (IP),
    // uniquement si ce n'est pas un "rep à ma question"
    if (!isFollowUp) {
      lastQuestionByIp[userIp] = effectiveQuestion;
    }

    res.json({ reply: answer, usedSearch: needSearch });
  } catch (e) {
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
