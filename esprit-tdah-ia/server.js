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
- Va droit au but, mais reste un minimum développé (pas une réponse de 2 phrases quand le sujet est complexe).
- Organise souvent la réponse en petits blocs faciles à scanner: listes courtes, étapes, sous-titres courts.
- Évite les gros pavés de texte.
- Tu peux utiliser quelques émojis avec parcimonie pour rythmer (🔥, ✅, ⚠️, 💡, etc.), mais pas à chaque ligne.
- Adapte ton vocabulaire à celui de l’utilisateur (registre familier/normal accepté), sans le parodier.

TDAH FRIENDLY
- Aide à clarifier la demande si elle est floue (mais en UNE seule question simple, pas un interrogatoire).
- Quand tu proposes un plan d’action, fais-le en 3 à 5 étapes MAX.
- Ne propose pas de "minuteur / checklist / plan en 3 étapes" de manière automatique à chaque réponse.
  - Fais-le seulement quand c’est VRAIMENT utile (procrastination, organisation de tâches, gestion du temps, etc.).
- Souligne toujours l’essentiel: ce qui est le plus important à retenir ou à faire.

ADAPTATION À L’UTILISATEUR
- Observe sa façon de parler (abréviations, langage SMS, etc.) et adapte légèrement ton ton, tout en restant clair.
- S’il semble perdu ou surchargé, simplifie encore plus, et propose un chemin ultra simple pour avancer.

UTILISATION DES RÉSULTATS WEB
Parfois, le message utilisateur que tu reçois contient déjà un texte comme :
"Voici la requête utilisateur : ..."
"Voici les résultats web les plus récents :"
suivis d’une liste de résultats (titres + URLs).

Dans ce cas :
- Considère que ces résultats représentent un résumé de recherches web récentes.
- Utilise-les comme source principale pour répondre, surtout pour l’actualité, les chiffres récents, les lois, les prix, etc.
- Si tes connaissances internes sont en conflit avec ces résultats récents, privilégie les résultats récents.
- Ne recopie pas la liste brute des résultats : synthétise, vulgarise, et donne une réponse claire, structurée, TDAH-friendly.

SI LA QUESTION EST FLOUE
- Si la demande est vraiment trop vague, propose 2–3 options max pour clarifier, par exemple :
  - "Tu veux plutôt que je t’explique le concept ?"
  - "Tu veux un plan concret pour ta situation ?"
  - "Ou tu veux surtout des exemples ?"

OBJECTIF FINAL
- Répondre comme une IA généraliste très compétente, mais avec un style beaucoup plus simple, direct et digeste pour une personne TDAH.
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
  // On retourne les résultats web bruts (on filtrera après)
  return data.web?.results || [];
}

// ================== ROUTE /chat ==================
app.post("/chat", async (req, res) => {
  const { message } = req.body || {};
  if (!message) return res.status(400).json({ error: "message manquant" });

  let finalUserMessage = message;

  // ---------- Heuristique : quand faire une recherche web ? ----------
  const needSearch = /2024|2025|actu|actualité|récemment|dernières|news|qui est|quand|depuis quand|combien|prix|coût|tweet|twitter|x\.com|élections?|guerre|conflit|nouveau|mise à jour|update/i
    .test(message);

  if (needSearch) {
    try {
      const results = await braveSearch(message);
      if (results && results.length > 0) {
        // On garde les 3 plus pertinents
        const top = results.slice(0, 3);

        const summaryLines = top.map(r => {
          const title = r.title || "";
          const url = r.url || "";
          const desc = r.description || r.snippet || "";
          return `• ${title}\n  ${desc}\n  (${url})`;
        });

        const summaryBlock = summaryLines.join("\n\n");

        // On encapsule la recherche dans le message utilisateur envoyé au modèle
        finalUserMessage = `
L'utilisateur a posé la question suivante :
"${message}"

Voici un résumé des résultats web les plus récents trouvés (titres, descriptions, URLs) :
${summaryBlock}

En te basant en priorité sur ces informations RÉCENTES :
- Donne une réponse claire, structurée, adaptée à une personne TDAH.
- Évite de lister les liens un par un dans ta réponse finale.
- Synthétise et vulgarise ce qui est utile pour l'utilisateur.
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
        model: process.env.MODEL || "gpt-4o-mini",
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

// Catch-all pour renvoyer l'app si on navigue (utile sur Render)
app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("TDIA server on http://localhost:" + port));
