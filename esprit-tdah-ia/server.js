// server.js
// TDAI-6 - Backend complet avec OpenAI + SerpAPI + historique court

import 'dotenv/config';
import express from 'express';
import { WebSocketServer } from 'ws';
import { OpenAI } from 'openai';
import path from 'path';
import { fileURLToPath } from 'url';

const app = express();
const port = process.env.PORT || 3000;

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const SERP_API_KEY = process.env.SERP_API_KEY || process.env.SERPAPI_API_KEY || '';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

// Pour servir les fichiers statiques (front)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.use(express.static(path.join(__dirname, 'public')));

// ---------------- CONFIG IA ----------------

const SYSTEM_PROMPT = `
Tu es TDAI, une IA conçue pour les esprits TDAH.

Règles importantes :
- L'utilisateur est en France. Quand tu parles de prix, d'abonnements, de services ou de produits, réponds par défaut pour la France, en euros, sauf si l'utilisateur demande clairement un autre pays.
- Utilise l'historique de la conversation uniquement si la nouvelle question a un lien logique clair avec les derniers messages. Si l'utilisateur change de sujet (par exemple en posant une question sans rapport), traite cette nouvelle question comme un nouveau sujet et ne mélange pas avec l'ancien.
- Si les résultats de recherche web sont contradictoires, incomplets ou peu clairs, dis que tu n'es pas sûr et propose de vérifier sur le site officiel, plutôt que d'inventer des chiffres ou des informations.
- Quand tu donnes un prix, donne un montant clair (par exemple un prix mensuel et éventuellement annuel). Ne donne pas plusieurs fourchettes différentes.
- Si tu as besoin de préciser le pays d'un prix que tu viens de citer, considère que, par défaut, il s'agit de la France, sauf mention explicite contraire.
`.trim();

/**
 * Construit la liste de messages à envoyer à OpenAI
 * On garde au maximum les 6 derniers messages de l'historique.
 */
function buildMessages(history, userMessage) {
  const base = [
    { role: 'system', content: SYSTEM_PROMPT },
  ];

  const trimmedHistory = history.slice(-6); // 6 derniers échanges (user/assistant confondus)
  return [...base, ...trimmedHistory, { role: 'user', content: userMessage }];
}

/**
 * Détermine si on doit déclencher une recherche web via SerpAPI
 * (logique simple mais efficace).
 */
function shouldSearch(userMessage) {
  const lower = userMessage.toLowerCase();

  const priceKeywords = ['prix', 'combien', 'cb', 'tarif', 'abonnement', 'abo', 'coûte', 'coute'];
  const webKeywords = ['google', 'internet', 'recherche', 'cherche sur', 'va voir'];

  if (webKeywords.some(k => lower.includes(k))) return true;
  if (priceKeywords.some(k => lower.includes(k))) return true;

  // Tu peux ajouter d'autres mots-clés ici si besoin.
  return false;
}

/**
 * Appel SerpAPI ciblé France.
 * On ajoute toujours "en France" au query + gl=fr / hl=fr.
 */
async function searchSerpAPI(query) {
  if (!SERP_API_KEY) {
    throw new Error('SERP_API_KEY manquante');
  }

  const q = `${query} en France`;
  const url = new URL('https://serpapi.com/search');
  url.searchParams.set('engine', 'google');
  url.searchParams.set('q', q);
  url.searchParams.set('hl', 'fr');
  url.searchParams.set('gl', 'fr');
  url.searchParams.set('api_key', SERP_API_KEY);

  console.log('[SerpAPI] Query envoyée :', q);

  const res = await fetch(url.toString());
  if (!res.ok) {
    console.error('[SerpAPI] Erreur HTTP :', res.status, await res.text());
    throw new Error('Erreur SerpAPI');
  }

  const data = await res.json();

  // On garde les 3 premiers résultats organiques, résumés.
  const organic = Array.isArray(data.organic_results) ? data.organic_results : [];
  const results = organic.slice(0, 3).map(r => ({
    title: r.title,
    snippet: r.snippet,
    link: r.link,
  }));

  console.log('[SerpAPI] Résumés :', results);
  return results;
}

/**
 * Appel OpenAI avec éventuellement les résultats SerpAPI comme contexte supplémentaire.
 */
async function askOpenAI(messages, serpResults = null) {
  if (serpResults && serpResults.length > 0) {
    const summary = serpResults
      .map((r, i) => `${i + 1}. ${r.title}\n${r.snippet || ''}`)
      .join('\n\n');

    messages.push({
      role: 'system',
      content: `
Voici des résultats de recherche web (France) que tu dois utiliser pour répondre à la question.
- Donne un prix clair en euros pour la France si l'utilisateur demande un prix ou un abonnement.
- Si les informations sont contradictoires ou incertaines, dis-le explicitement et invite l'utilisateur à vérifier sur le site officiel.
- Ne mélange pas ce contexte avec un autre sujet qui n'a rien à voir.

Résultats web résumés :
${summary}
      `.trim(),
    });
  }

  const completion = await openai.chat.completions.create({
    model: OPENAI_MODEL,
    messages,
    temperature: 0.3,
  });

  const answer = completion.choices[0]?.message?.content?.trim() || "Je n'ai pas réussi à formuler une réponse. Réessaie ou précise ta question.";
  return answer;
}

// ---------------- SERVEUR HTTP ----------------

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const server = app.listen(port, () => {
  console.log(`TDAI backend listening on port ${port}`);
});

// ---------------- WEBSOCKET ----------------

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  console.log('[WS] Nouvelle connexion');

  // Historique propre à cette connexion
  const history = [];

  ws.on('message', async (data) => {
    let payload;
    try {
      payload = JSON.parse(data.toString());
    } catch (err) {
      console.error('[WS] Payload invalide:', err);
      return;
    }

    if (payload.type !== 'user_message') return;

    const userMessage = (payload.text || '').toString().trim();
    if (!userMessage) return;

    console.log('[User]', userMessage);

    // Construction des messages avec historique (6 derniers)
    const messages = buildMessages(history, userMessage);

    let serpResults = null;

    try {
      // 1) Optionnel : on peut envoyer un statut "thinking" si tu veux gérer ça côté front
      // ws.send(JSON.stringify({ type: 'status', value: 'thinking' }));

      // 2) Déclencher éventuellement SerpAPI
      if (SERP_API_KEY && shouldSearch(userMessage)) {
        // Informer le front que la recherche web commence
        ws.send(JSON.stringify({ type: 'status', value: 'searching-serpapi' }));

        try {
          serpResults = await searchSerpAPI(userMessage);
        } catch (err) {
          console.error('[SerpAPI] Erreur :', err.message);
          serpResults = null; // on continue quand même sans résultats web
        }

        // Informer le front que la recherche web est terminée
        ws.send(JSON.stringify({ type: 'status', value: 'searching-done' }));
      }

      // 3) Appel OpenAI avec ou sans résultats web
      const answer = await askOpenAI(messages, serpResults);

      console.log('[TDAI]', answer);

      // 4) Mise à jour de l'historique
      history.push({ role: 'user', content: userMessage });
      history.push({ role: 'assistant', content: answer });

      // 5) Envoi de la réponse à l'UI
      ws.send(JSON.stringify({
        type: 'assistant_message',
        text: answer,
      }));
    } catch (err) {
      console.error('[WS] Erreur traitement message:', err);

      ws.send(JSON.stringify({
        type: 'assistant_message',
        text: "Je rencontre un souci technique pour l'instant. Vérifie ta connexion ou réessaie dans quelques instants.",
      }));
    }
  });

  ws.on('close', () => {
    console.log('[WS] Connexion fermée');
  });
});
