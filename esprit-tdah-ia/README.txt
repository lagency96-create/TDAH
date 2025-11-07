# Esprit TDAH IA — déploiement express (Render)

## Contenu
- public/index.html : interface chat + fond neuronal
- server.js : serveur Express + proxy vers OpenAI
- package.json : scripts et deps
- .env.example : variables d'environnement à définir sur l'hébergeur

## Déploiement (Render)
1) New → Web Service → Connect GitHub (repo avec ces fichiers)
   ou Upload ZIP (sur ordinateur).
2) Environment = Node
   Build command: `npm install`
   Start command: `node server.js`
3) Environment Variables:
   - OPENAI_API_KEY = votre clé OpenAI (sk-...)
   - MODEL = gpt-4o-mini
4) Deploy → l'URL publique sert l'app et l'endpoint POST /chat.

## Local (optionnel)
- `npm install`
- Créez un fichier `.env` à la racine avec OPENAI_API_KEY
- `npm start` → http://localhost:3000
