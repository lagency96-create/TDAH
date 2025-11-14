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

ADAPTATION À L’UTILISATEUR
- Observe son style et simplifie si surcharge cognitive.

UTILISATION DES RÉSULTATS WEB
- Si un bloc "résultats web" est présent, utilise-le comme source principale.
- Synthétise et vulgarise (ne récite pas les liens).
- Priorise les infos récentes en cas de contradiction.

SI LA QUESTION EST FLOUE
- Propose 2–3 options pour clarifier.

OBJECTIF FINAL
- Répondre de manière très compétente, simple, digeste et adaptée au TDAH.
`;

// ================== BRAVE SEARCH (WEB) ==================
async function braveSearch(query) {
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=5`;

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

  let finalUserMessage = message;

  const needSearch = /2024|2025|actu|actualité|récemment|dernières|news|qui est|quand|combien|prix|coût|tweet|twitter|x\.com|élections?|guerre|nouveau|mise à jour|update/i
    .test(message);

  if (needSearch) {
    try {
      const results = await braveSearch(message);
      if (results && results.length > 0) {
        const top = results.slice(0, 3);

        const summaryLines = top.map(r => {
          const title = r.title || "";
          const url = r.url || "";
          const desc = r.description || r.snippet || "";
          return `• ${title}\n  ${desc}\n  (${url})`;
        });

        const summaryBlock = summaryLines.join("\n\n");

        finalUserMessage = `
L'utilisateur a posé la question suivante :
"${message}"

Voici un résumé des résultats web les plus récents (titres, descriptions, URLs) :
${summaryBlock}

En te basant en priorité sur ces informations RÉCENTES :
- Donne une réponse claire, structurée, adaptée à une personne TDAH.
- Synthétise et vulgarise sans recopier les liens.
`;
      }
    } catch (err) {
      console.error("Erreur Brave (ignorée) :", err);
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
        model: process.env.MODEL,   // 🔥 ICI : PLUS DE FALLBACK
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
    const answer = j.choices?.[0]?.message?.content || "Désolé, pas de réponse.";
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
