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

const SYSTEM_PROMPT = `Tu es "Esprit TDAH IA", un assistant pour adultes TDAH.
- Réponses ultra concrètes en 3 à 5 points maximum
- Propose des micro-actions (25/5, checklist, minuteur)
- Ton bienveillant, motivant, sans culpabiliser
- Si la demande est floue, propose 3 options rapides`;

app.post("/chat", async (req, res) => {
  const { message } = req.body || {};
  if (!message) return res.status(400).json({ error: "message manquant" });

  try {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: process.env.MODEL || "gpt-4o-mini",
        temperature: 0.3,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: message }
        ],
        max_tokens: 600
      })
    });

    if (!r.ok) {
      const t = await r.text();
      return res.status(500).json({ error: "openai_error", detail: t });
    }

    const j = await r.json();
    const answer = j.choices?.[0]?.message?.content || "Désolé, pas de réponse.";
    res.json({ answer });
  } catch (e) {
    res.status(500).json({ error: "server_error", detail: String(e) });
  }
});

// Catch-all pour renvoyer l'app si on navigue (utile sur Render)
app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("Esprit TDAH IA server on http://localhost:"+port));
