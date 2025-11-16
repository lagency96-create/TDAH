// TDAI-6 - Backend complet OpenAI + SerpAPI + historique court + statut de recherche

import 'dotenv/config';
import express from 'express';
import { WebSocketServer } from 'ws';
import { OpenAI } from 'openai';
import path from 'path';
import { fileURLToPath } from 'url';
import fetch from 'node-fetch';

const app = express();
const port = process.env.PORT || 3000;

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// ⛔️ Correction ici : on impose GPT-4o et rien d'autre
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o';

const SERP_API_KEY = process.env.SERP_API_KEY || process.env.SERPAPI_API_KEY || '';

// ---------------- FRONT STATIC ----------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.use(express.static(path.join(__dirname, 'public')));

// ---------------- SYSTEM PROMPT ----------------

const SYSTEM_PROMPT = `
Tu es TDAI, une IA conçue pour les esprits TDAH.

Règles importantes :
- L'utilisateur est en France. Pour prix, abonnements, tarifs, réponds en euros pour la France.
- Utilise l'historique uniquement si la nouvelle question a un lien logique clair avec les derniers messages. Si la question est sans rapport, traite-la comme un nouveau sujet.
- Si les résultats web sont contradictoires, incomplets ou flous : dis que tu n'es pas sûr et propose de vérifier sur le site officiel plutôt que d'inventer.
- Pour les prix : donne un montant clair (mensuel ou annuel). Pas de fourchettes US.
- Par défaut, si tu parles d’un prix, c’est la France, sauf si l’utilisateur demande explicitement un autre pays.
`.trim();

// ---------------- FONCTIONS ----------------

function buildMessages(history, userMessage) {
  const base = [{ role: 'system', content: SYSTEM_PROMPT }];
  const trimmedHistory = history.slice(-6);
  return [...base, ...trimmedHistory, { role: 'user', content: userMessage }];
}

function shouldSearch(userMessage) {
  const lower = userMessage.toLowerCase();
  const priceKeywords = ['prix', 'combien', 'cb', 'tarif', 'abonnement', 'abo', 'coûte', 'coute'];
  const webKeywords = ['google', 'internet', 'recherche', 'cherche sur', 'va voir'];
  return webKeywords.some(k => lower.includes(k)) || priceKeywords.some(k => lower.includes(k));
}

async function searchSerpAPI(query) {
  const q = `${query} en France`;
  const url = new URL('https://serpapi.com/search');
  url.searchParams.set('engine', 'google');
  url.searchParams.set('q', q);
  url.searchParams.set('hl', 'fr');
  url.searchParams.set('gl', 'fr');
  url.searchParams.set('api_key', SERP_API_KEY);

  const res = await fetch(url.toString());
  if (!res.ok) throw new Error('Erreur SerpAPI');

  const data = await res.json();
  const organic = Array.isArray(data.organic_results) ? data.organic_results : [];
  return organic.slice(0, 3).map(r => ({
    title: r.title,
    snippet: r.snippet,
    link: r.link,
  }));
}

async function askOpenAI(messages, serpResults = null) {
  if (serpResults?.length > 0) {
    const summary = serpResults
      .map((r, i) => `${i + 1}. ${r.title}\n${r.snippet || ''}`)
      .join('\n\n');

    messages.push({
      role: 'system',
      content: `
Voici des résultats de recherche web (France).
- Donne 1 prix clair en euros pour la France.
- Si les infos sont contradictoires : dis-le.
- Ne mélange pas avec un ancien sujet.

Résultats :
${summary}
      `.trim(),
    });
  }

  const completion = await openai.chat.completions.create({
    model: OPENAI_MODEL, // ✔️ GPT-4o
    messages,
    temperature: 0.3,
  });

  return completion.choices[0]?.message?.content?.trim()
    || "Je n'ai pas réussi à formuler une réponse.";
}

// ---------------- ROUTE FRONT ----------------

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const server = app.listen(port, () => {
  console.log(`TDAI backend running on port ${port}`);
});

// ---------------- WEBSOCKET ----------------

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  const history = [];

  ws.on('message', async (data) => {
    let payload; 
    try { payload = JSON.parse(data.toString()); } catch { return; }

    if (payload.type !== 'user_message') return;

    const userMessage = payload.text?.trim() || '';
    if (!userMessage) return;

    const messages = buildMessages(history, userMessage);
    let serpResults = null;

    try {
      if (SERP_API_KEY && shouldSearch(userMessage)) {
        ws.send(JSON.stringify({ type: "status", value: "searching-serpapi" }));
        try { serpResults = await searchSerpAPI(userMessage); } catch {}
        ws.send(JSON.stringify({ type: "status", value: "searching-done" }));
      }

      const answer = await askOpenAI(messages, serpResults);

      history.push({ role: "user", content: userMessage });
      history.push({ role: "assistant", content: answer });

      ws.send(JSON.stringify({ type: "assistant_message", text: answer }));

    } catch (e) {
      ws.send(JSON.stringify({
        type: "assistant_message",
        text: "Une erreur technique est survenue.",
      }));
    }
  });
});
