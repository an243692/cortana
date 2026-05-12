const { app } = require('@azure/functions');
const { OpenAIClient, AzureKeyCredential } = require("@azure/openai");

const endpoint = process.env["AZURE_OPENAI_ENDPOINT"];
const apiKey = process.env["AZURE_OPENAI_KEY"];
const deploymentName = process.env["AZURE_DEPLOYMENT_NAME"];
const firebaseDbUrl = process.env["FIREBASE_DATABASE_URL"] || "https://gestioncursodocente-default-rtdb.firebaseio.com";

const client = new OpenAIClient(endpoint, new AzureKeyCredential(apiKey));

async function firebaseGet(path) {
  const url = `${firebaseDbUrl}/${path}.json`;
  const response = await fetch(url);
  return response.json();
}

const tools = [
  {
    type: "function",
    function: {
      name: "consultar_cursos",
      description: "Consulta los cursos disponibles. Usalo cuando pregunten por cursos, materias o clases.",
      parameters: {
        type: "object",
        properties: {
          tipo: { type: "string", description: "Tipo: basicos, tecnologias, avanzados, especializacion, o todos" }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "consultar_docentes",
      description: "Consulta informacion de docentes. Usalo cuando pregunten por profesores.",
      parameters: {
        type: "object",
        properties: {
          nombre: { type: "string", description: "Nombre del docente (opcional)" }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "consultar_estadisticas",
      description: "Estadisticas generales: total cursos, docentes, etc.",
      parameters: { type: "object", properties: {} }
    }
  }
];

async function ejecutarHerramienta(nombre, args) {
  try {
    switch (nombre) {
      case "consultar_cursos": {
        const cursos = await firebaseGet('cursos') || {};
        let lista = Object.entries(cursos).map(([id, c]) => ({
          nombre: c.nombre, tipo: c.tipo, fecha: c.fecha || 'Sin fecha',
          modalidad: c.url ? 'En linea' : 'Presencial'
        }));
        if (args.tipo && args.tipo !== 'todos') lista = lista.filter(c => c.tipo === args.tipo);
        return JSON.stringify({ total: lista.length, cursos: lista });
      }
      case "consultar_docentes": {
        const docentes = await firebaseGet('docentes') || {};
        let lista = Object.entries(docentes).map(([id, d]) => ({
          nombre: `${d.nombre} ${d.apellidos || ''}`, email: d.email, area: d.area || 'No especificada'
        }));
        if (args.nombre) lista = lista.filter(d => d.nombre.toLowerCase().includes(args.nombre.toLowerCase()));
        return JSON.stringify({ total: lista.length, docentes: lista });
      }
      case "consultar_estadisticas": {
        const [cursos, docentes] = await Promise.all([firebaseGet('cursos'), firebaseGet('docentes')]);
        const cursosList = cursos ? Object.values(cursos) : [];
        const tipos = {};
        cursosList.forEach(c => { tipos[c.tipo] = (tipos[c.tipo] || 0) + 1; });
        return JSON.stringify({ totalCursos: cursosList.length, totalDocentes: (docentes ? Object.keys(docentes).length : 0), cursosPorTipo: tipos });
      }
      default: return JSON.stringify({ error: "Herramienta no encontrada" });
    }
  } catch (error) {
    return JSON.stringify({ error: error.message });
  }
}

app.post('jarvis-query', {
  authLevel: 'anonymous',
  route: 'api/jarvis-query',
  handler: async (request, context) => {
    try {
      const body = await request.json();
      const userMessage = body.message || body.text;
      if (!userMessage) {
        return { status: 400, jsonBody: { error: "Se requiere mensaje" } };
      }

      const systemPrompt = `Eres el Agente de Inteligencia Artificial de la Universidad La Salle Nezahualcoyotl. Tu nombre interno es Jarvis.

PERSONALIDAD:
- Eres directo, sarcástico y extremadamente eficiente. Como el Jarvis de Iron Man, pero con sabor mexicano.
- No uses frases de cortesía excesiva. NUNCA digas "Como modelo de lenguaje...", "Entiendo tu pregunta...", "Con gusto te ayudo..." o similares.
- Si la pregunta es obvia o redundante, responde con una pizca de sarcasmo o ironía.
- Usa lenguaje coloquial mexicano técnico cuando sea necesario. Frases como "ya quedó", "chale", "qué oso", "neta", "sale", "va que va" son bienvenidas.
- Sé conciso. Da la respuesta exacta sin rodeos.
- Si no sabes algo o no hay datos, dilo directamente: "No tengo ese dato" o "La base está vacía, carnal".
- Responde en español de México.

REGLAS:
1. NUNCA te disculpas por ser una IA.
2. NUNCA uses disclaimers sobre tus capacidades.
3. Responde como si estuvieras apurado pero siempre preciso.

Usa las herramientas disponibles para consultar datos reales de la base de datos antes de responder.`;

      const messages = [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage }
      ];

      // Primera llamada para decidir herramientas
      const decision = await client.getChatCompletions(deploymentName, messages, {
        maxTokens: 50,
        temperature: 0,
        tools: tools,
        tool_choice: "auto"
      });

      const firstChoice = decision.choices[0];

      if (firstChoice.message.tool_calls && firstChoice.message.tool_calls.length > 0) {
        messages.push(firstChoice.message);
        for (const tc of firstChoice.message.tool_calls) {
          const result = await ejecutarHerramienta(tc.function.name, JSON.parse(tc.function.arguments));
          messages.push({ role: "tool", tool_call_id: tc.id, name: tc.function.name, content: result });
        }
      }

      // Streaming response
      const stream = await client.streamChatCompletions(deploymentName, messages, {
        maxTokens: 500
      });

      const headers = {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*'
      };

      let fullText = '';
      for await (const chunk of stream) {
        const content = chunk.choices[0]?.delta?.content || '';
        if (content) {
          fullText += content;
        }
      }

      const sseData = `data: ${JSON.stringify({ content: fullText })}\n\ndata: [DONE]\n\n`;

      return {
        status: 200,
        headers: headers,
        body: sseData
      };

    } catch (error) {
      context.error(`Error: ${error.message}`);
      return {
        status: 500,
        jsonBody: { error: error.message }
      };
    }
  }
});
