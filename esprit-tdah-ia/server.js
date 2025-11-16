// server.js
import 'dotenv/config';
import express from 'express';
import { WebSocketServer } from 'ws';
import { OpenAI } from 'openai';
import fetch from 'node-fetch';

const app = express();
const port = process.env.PORT || 3000;

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const SERP_API_KEY = process.env.SERP_API_KEY;

// --------- CONFIG IA ---------
const SYSTEM_PROMPT = `
Tu es TDAI, une IA spécialisée pour les esprits TDAH.

Règles importantes :
- L'utilisateur est en France. Quand tu parles de prix ou d'abonnements, réponds par défaut pour la France, en euros, sauf si l'utilisateur te demande clairement un autre pays.
- Utilise l'historique UNIQUEMENT si la nouvelle question a un lien logique avec les messages précédents. Si la question part sur un autre sujet, traite-la comme un nouveau sujet.
- Si les résultats web sont contradictoires ou pas clairs, dis que tu n'es pas sûr et conseille de vérifier sur le site officiel, plutôt que d'inventer.
- Pour les prix : donne 1 prix clair (mensuel et éventuellement annuel), pas 3 fourchettes différentes.
`;

// On garde un historique par connexion (simplifié)
function buildMessages(history, userMessage) {
  const base = [{ role: 'system', content: SYSTEM_PROMPT }];
  const trimmedHistory = history.slice(-6); // 6 derniers messages max
  return [...base, ...trimmedHistory, { role: 'user', content: userMessage }];
}

// Détection simple : est-ce qu'on doit lancer SerpAPI ?
function shouldSearch(userMessage) {
  const lower = userMessage.toLowerCase();
  const keywords = ['prix', 'combien', 'cb', 'tarif', 'abonnement', 'amazon', 'prime'];
  return keywords.some(k => lower.includes(k));
}

// Appel SerpAPI ciblé France
async function searchSerpAPI(query) {
  const url = new URL('https://serpapi.com/search');
  url.searchParams.set('engine', 'google');
  url.searchParams.set('q', `${query} en France`);
  url.searchParams.set('hl', 'fr');
  url.searchParams.set('gl', 'fr');
  url.searchParams.set('api_key', SERP_API_KEY);

  const res = await fetch(url.toString());
  if (!res.ok) throw new Error('Erreur SerpAPI');
  const data = await res.json();

  // On extrait un résumé très simple (title + snippet des 3 premiers résultats)
  const results = (data.organic_results || []).slice(0, 3).map(r => ({
    title: r.title,
    snippet: r.snippet,
    link: r.link,
  }));

  return results;
}

async function askOpenAI(messages, serpResults = null) {
  // Si on a des résultats web, on les ajoute comme contexte
  if (serpResults) {
    const summary = serpResults
      .map((r, i) => `${i + 1}. ${r.title}\n${r.snippet}`)
      .join('\n\n');

    messages.push({
      role: 'system',
      content: `
Voici des résultats de recherche web (France) dont tu dois te servir.
Ne donne qu'un prix clair en euros pour la France si possible.
Si ces infos sont floues ou contradictoires, dis que tu n'es pas sûr.

Résultats :
${summary}
      `.trim(),
    });
  }

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages,
    temperature: 0.3,
  });

  return completion.choices[0].message.content.trim();
}

// ------------ HTTP + WS -------------
const server = app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  // historique propre à cette connexion
  const history = [];

  ws.on('message', async (data) => {
    let payload;
    try {
      payload = JSON.parse(data.toString());
    } catch {
      return;
    }

    if (payload.type !== 'user_message') return;
    const userMessage = payload.text?.toString() || '';

    // Construire messages avec historique (6 derniers)
    const messages = buildMessages(history, userMessage);

    let serpResults = null;

    try {
      // On décide si on cherche sur le web
      if (SERP_API_KEY && shouldSearch(userMessage)) {
        // On informe le front qu'on lance une recherche
        ws.send(JSON.stringify({ type: 'status', value: 'searching-serpapi' }));

        serpResults = await searchSerpAPI(userMessage);

        // Fin de la recherche
        ws.send(JSON.stringify({ type: 'status', value: 'searching-done' }));
      }

      const answer = await askOpenAI(messages, serpResults);

      // On met à jour l'historique
      history.push({ role: 'user', content: userMessage });
      history.push({ role: 'assistant', content: answer });

      // On renvoie la réponse à l'UI
      ws.send(JSON.stringify({ type: 'assistant_message', text: answer }));
    } catch (err) {
      console.error(err);
      ws.send(JSON.stringify({
        type: 'assistant_message',
        text: "Je rencontre un souci technique pour l'instant, réessaie dans un instant ou vérifie directement sur le site officiel.",
      }));
    }
  });
});
