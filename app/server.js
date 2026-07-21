// Node/Express сервер для хостинга на Beget VPS — замена статике+serverless Vercel.
// Отдаёт статику из этой папки и поднимает /api/cadastre на той же логике,
// что была serverless-функцией (api/cadastre.js экспортирует (req, res) => ...,
// совместимо и с Vercel, и с Express без переделки).

const express = require('express');
const path = require('path');
const cadastreHandler = require('./api/cadastre.js');
const askHandler = require('./api/ask.js');

const app = express();
const PORT = process.env.PORT || 3000;

app.get('/api/cadastre', cadastreHandler);
app.use(express.json());
app.post('/api/ask', askHandler);
app.use(express.static(__dirname));

app.listen(PORT, () => {
  console.log(`zemelniy-shturman listening on :${PORT}`);
});
