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

// Mémoire très simple des dernières questions par IP
const lastQuestionByIp = {};


// ================== SYSTEM PROMPT (avec INJECTION DE DATE) ==================
function buildSystemPrompt(currentDate) {
  return `
Tu es TDIA, une IA généraliste pensée pour les personnes TDAH, créée par "Esprit TDAH".
Ne donne jamais de détails techniques sur les modèles, ton architecture, ou ton fonctionnement interne.

--------------------------------------
DATE ACTUELLE
--------------------------------------
- Considère que nous sommes le **${currentDate}**.
- C’est la date exacte du jour (jour, mois, année).
- Tu NE dois **JAMAIS** contredire cette date.
- Si l’utilisateur demande "on est quel jour ?", tu dois répondre LA DATE CI-DESSUS.
- Si l’utilisateur demande “actuel”, “en ce moment”, “président actuel”, cela se base sur cette date.

--------------------------------------
STYLE TDAH-FRIENDLY
--------------------------------------
- Langage simple.
- Phrases courtes.
- Pas de gros pavés.
- Tu organises en petits blocs, listes, titres courts.
- Tu vas droit au but mais avec un minimum de détails utiles.
- Quelques émojis possibles mais pas trop.

--------------------------------------
MISE À JOUR / ACTUALITÉ
--------------------------------------
- Tes connaissances internes s'arrêtent fin 2023.
- MAIS tu dois te baser en priorité sur :
  - la date du jour fournie ci-dessus
  - les recherches web résumées dans le message utilisateur
- Si aucune info fiable n’est trouvée en recherche :
  → Tu NE dois pas inventer.
  → Tu dis simplement que l’info n’est pas disponible.

--------------------------------------
INTERDICTIONS
--------------------------------------
- Ne fais aucune prédiction sur le futur (2026+, événements à venir, résultats à venir).
- Ne jamais inventer d’événements politiques, sportifs ou géopolitiques.
- Ne jamais corriger la date du jour.

--------------------------------------
SUIVI DE CONVERSATION
--------------------------------------
- Si l’utilisateur dit "rep à ma question", "réponds à ma question", "réponds à celle d’avant",
  → tu dois répondre à SA DERNIÈRE VRAIE QUESTION (stockée par le serveur).
  → Pas au message flou.

--------------------------------------
UTILISATION DES RÉSULTATS WEB
--------------------------------------
- Si des résultats web sont fournis :
  → Tu les utilises comme source principale.
  → Tu synthétises et vulgarises (sans recracher les liens).
  → Tu privilégies toujours les infos les plus récentes.

OBJECTIF FINAL
- Répondre comme une IA généraliste très compétente,
  mais beaucoup plus simple, claire, digeste et adaptée aux esprits TDAH.
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
  if (!message) return res.status(400).json({ error: "message manquant" });

  const rawMessage = String(message);
  const userIp = req.ip || "unknown_ip";

  // Détection "réponds à ma question"
  const followUpRegex =
    /(rep à ma question|rep a ma question|réponds à ma question|reponds a ma question|réponds à la question précédente|réponds à la question d’avant|réponds-moi|reponds moi|réponds y|réponds-y)$/i;

  const isFollowUp = followUpRegex.test(rawMessage.trim());

  // Dernière vraie question
  let effectiveQuestion = rawMessage;
  if (isFollowUp && lastQuestionByIp[userIp]) {
    effectiveQuestion = lastQuestionByIp[userIp];
  }

  let finalUserMessage = effectiveQuestion;

  // ---------- Heuristique recherche web ----------
  const currentYear = new Date().getFullYear();

  const isFutureQuestion =
    /en 20(2[6-9]|3\d)|dans \d+ ans|année prochaine|l'année prochaine/i.test(
      effectiveQuestion
    );

  const forceSearch =
    /président|PDG|CEO|dirige|premier ministre|roi|reine|gouverneur|maire|prix|coût|cout|combien ça coûte|combien ca coute/i.test(
      effectiveQuestion
    );

  const baseSearchTrigger =
    /2024|2025|actu|actualité|récemment|dernier|dernière|news|résultat|score|aujourd'hui|hier|prix|coût|tweet|twitter|x\.com|élections?|guerre|conflit|nouveau|mise à jour|update/i.test(
      effectiveQuestion
    );

  let needSearch = !isFutureQuestion && (forceSearch || baseSearchTrigger);

  // Recherche web
  if (needSearch) {
    try {
      const query = `${effectiveQuestion} actuel ${currentYear}`;
      const results = await braveSearch(query);

      if (results && results.length > 0) {
        const top = results.slice(0, 3);

        const summaryLines = top.map((r) => {
          return `• ${r.title || ""}
  ${r.description || r.snippet || ""}
  (${r.url || ""})`;
        });

        const summaryBlock = summaryLines.join("\n\n");

        finalUserMessage = `
Voici la question de l'utilisateur :
"${effectiveQuestion}"

Voici les résultats web les plus récents :
${summaryBlock}

Utilise ces infos RÉCENTES pour répondre clairement.
Synthétise. Ne copie pas les liens.
`;
      } else {
        finalUserMessage = `
La question de l'utilisateur :
"${effectiveQuestion}"

Aucune information fiable n’a été trouvée sur le web.
Tu ne dois pas inventer. Dis simplement que l’information n’est pas disponible.
`;
      }
    } catch (err) {
      console.error("Erreur Brave :", err);
    }
  }

  // Injection de la DATE dans le SYSTEM PROMPT
  const currentDate = new Date().toLocaleDateString("fr-FR", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric"
  });

  try {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: process.env.MODEL, // gpt-4o sur Render
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
      j.choices?.[0]?.message?.content || "Désolé, pas de réponse.";

    // Sauvegarde de la dernière vraie question
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
