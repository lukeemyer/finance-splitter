const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
};

const MAX_BODY_BYTES = 6 * 1024 * 1024; // 6 MB — a downscaled JPEG receipt photo, not app state

const RECORD_RECEIPT_TOOL = {
  name: 'record_receipt',
  description: 'Record the line items and totals read from a photo of a paper receipt.',
  input_schema: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            price: { type: 'number' },
          },
          required: ['name', 'price'],
        },
      },
      subtotal: { type: 'number' },
      tax: { type: 'number' },
      tip: { type: 'number' },
      total: { type: 'number' },
    },
    required: ['items', 'total'],
  },
};

export default async function handler(req, res) {
  Object.entries(CORS_HEADERS).forEach(([k, v]) => res.setHeader(k, v));

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const auth = req.headers.authorization;
  if (!auth || auth !== `Bearer ${process.env.SHARED_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const body = req.body;
  if (!body || typeof body !== 'object' || typeof body.image !== 'string') {
    return res.status(400).json({ error: 'Request body must include a base64 image' });
  }

  const bodyStr = JSON.stringify(body);
  if (bodyStr.length > MAX_BODY_BYTES) {
    return res.status(413).json({ error: 'Photo too large' });
  }

  const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/.exec(body.image);
  if (!match) {
    return res.status(400).json({ error: 'Image must be a base64 data URL' });
  }
  const [, mediaType, base64Data] = match;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 1536,
        tools: [RECORD_RECEIPT_TOOL],
        tool_choice: { type: 'tool', name: 'record_receipt' },
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64Data } },
              {
                type: 'text',
                text: 'Extract every line item (name and price), plus subtotal, tax, tip, and the final total from this receipt photo. Omit a field if it is not present on the receipt.',
              },
            ],
          },
        ],
      }),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      console.error('Anthropic API error', response.status, errText.slice(0, 500));
      return res.status(502).json({ error: 'Could not read that receipt — try a clearer photo.' });
    }

    const data = await response.json();
    const toolUse = (data.content || []).find((block) => block.type === 'tool_use');
    if (!toolUse || !toolUse.input || !Array.isArray(toolUse.input.items) || typeof toolUse.input.total !== 'number') {
      return res.status(502).json({ error: 'Could not read that receipt — try a clearer photo.' });
    }

    return res.status(200).json(toolUse.input);
  } catch (err) {
    console.error('parse-receipt exception', err);
    return res.status(502).json({ error: 'Could not read that receipt — try a clearer photo.' });
  }
}
