'use strict';
const express = require('express');
const path = require('path');
const { runAssistant } = require('../lib/ai/assistant');
const app = express();
const PORT = Number(process.env.PORT || 3000);
app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, '..', 'frontend'), { extensions: ['html'] }));
app.get('/api/health', (_req, res) => res.json({ ok: true, app: 'ARTEMIS R69', version: '6.0.0', mode: 'analysis-only', persistentWrites: false, felExecEnabled: false }));
app.get('/api/build', (_req, res) => res.json(require('../BUILD_INFO.json')));
app.post('/api/assistant', async (req, res) => {
  try {
    const { prompt, context } = req.body || {};
    if (typeof prompt !== 'string' || !prompt.trim()) return res.status(400).json({ error: 'prompt_required' });
    if (prompt.length > 12000) return res.status(413).json({ error: 'prompt_too_long' });
    const result = await runAssistant(prompt.trim(), context || {});
    res.json(result);
  } catch (e) { res.status(500).json({ error: 'assistant_error', message: e.message }); }
});
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, '..', 'frontend', 'index.html')));
app.listen(PORT, '0.0.0.0', () => console.log(`ARTEMIS R69 v6 listening on ${PORT}`));
