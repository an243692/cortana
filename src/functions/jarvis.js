const { app } = require('@azure/functions');
const { OpenAIClient, AzureKeyCredential } = require("@azure/openai");

const endpoint = process.env["AZURE_OPENAI_ENDPOINT"];
const apiKey = process.env["AZURE_OPENAI_KEY"];
const deploymentName = process.env["AZURE_DEPLOYMENT_NAME"];
const firebaseDbUrl = process.env["FIREBASE_DATABASE_URL"] || "https://gestioncursodocente-default-rtdb.firebaseio.com";

if (!endpoint || !apiKey) {
    console.error("Faltan variables de entorno para Azure OpenAI");
}

const client = new OpenAIClient(endpoint, new AzureKeyCredential(apiKey));

// Firebase REST API helpers
async function firebaseGet(path) {
    const url = `${firebaseDbUrl}/${path}.json`;
    const response = await fetch(url);
    return response.json();
}

const firebaseTools = [
    {
        type: "function",
        function: {
            name: "consultar_cursos",
            description: "Consulta los cursos disponibles en la base de datos. Úsalo cuando pregunten por cursos, materias, clases o asignaturas.",
            parameters: {
                type: "object",
                properties: {
                    tipo: { type: "string", description: "Tipo de curso: basicos, tecnologias, avanzados, especializacion, o todos" }
                },
                required: []
            }
        }
    },
    {
        type: "function",
        function: {
            name: "consultar_docentes",
            description: "Consulta información sobre los docentes registrados. Úsalo cuando pregunten por profesores, maestros o personal docente.",
            parameters: {
                type: "object",
                properties: {
                    nombre: { type: "string", description: "Nombre del docente a buscar (opcional)" }
                },
                required: []
            }
        }
    },
    {
        type: "function",
        function: {
            name: "consultar_estadisticas",
            description: "Obtiene estadísticas generales del sistema: total de cursos, docentes, tipos de curso, etc.",
            parameters: {
                type: "object",
                properties: {},
                required: []
            }
        }
    }
];

async function ejecutarHerramienta(nombre, argumentos) {
    try {
        switch (nombre) {
            case "consultar_cursos": {
                const cursos = await firebaseGet('cursos') || {};
                let lista = Object.entries(cursos).map(([id, c]) => ({
                    nombre: c.nombre,
                    tipo: c.tipo,
                    fecha: c.fecha || 'Sin fecha',
                    modalidad: c.url ? 'En línea' : 'Presencial'
                }));
                
                if (argumentos.tipo && argumentos.tipo !== 'todos') {
                    lista = lista.filter(c => c.tipo === argumentos.tipo);
                }
                
                return JSON.stringify({ total: lista.length, cursos: lista });
            }
            
            case "consultar_docentes": {
                const docentes = await firebaseGet('docentes') || {};
                let lista = Object.entries(docentes).map(([id, d]) => ({
                    nombre: `${d.nombre} ${d.apellidos || ''}`,
                    email: d.email,
                    area: d.area || 'No especificada'
                }));
                
                if (argumentos.nombre) {
                    lista = lista.filter(d => d.nombre.toLowerCase().includes(argumentos.nombre.toLowerCase()));
                }
                
                return JSON.stringify({ total: lista.length, docentes: lista });
            }
            
            case "consultar_estadisticas": {
                const [cursos, docentes] = await Promise.all([
                    firebaseGet('cursos'),
                    firebaseGet('docentes')
                ]);
                
                const cursosList = cursos ? Object.values(cursos) : [];
                const docentesList = docentes ? Object.values(docentes) : [];
                
                const tipos = {};
                cursosList.forEach(c => {
                    tipos[c.tipo] = (tipos[c.tipo] || 0) + 1;
                });
                
                return JSON.stringify({
                    totalCursos: cursosList.length,
                    totalDocentes: docentesList.length,
                    cursosPorTipo: tipos
                });
            }
            
            default:
                return JSON.stringify({ error: "Herramienta no encontrada" });
        }
    } catch (error) {
        return JSON.stringify({ error: error.message });
    }
}

app.post('jarvis-query', {
    authLevel: 'anonymous',
    handler: async (request, context) => {
        context.log(`Procesando solicitud para Jarvis...`);

        try {
            const body = await request.json();
            const userMessage = body.message || body.text;

            if (!userMessage) {
                return {
                    status: 400,
                    jsonBody: { error: "Se requiere un mensaje de texto." }
                };
            }

            const systemMessage = {
                role: "system",
                content: `Eres Jarvis, el asistente virtual inteligente de la Universidad La Salle Nezahualcóyotl.
                Eres profesional, eficiente y experto en el sistema de gestión de cursos.
                Tus respuestas deben ser concisas, útiles y con un tono académico pero accesible.
                Usa las herramientas disponibles para consultar datos reales de la base de datos.
                Si no encuentras información, dilo claramente.
                Responde siempre en español.`
            };

            const messages = [
                systemMessage,
                { role: "user", content: userMessage }
            ];

            const response = await client.getChatCompletions(deploymentName, messages, {
                maxTokens: 800,
                tools: firebaseTools,
                tool_choice: "auto"
            });

            const firstChoice = response.choices[0];
            
            if (firstChoice.message.tool_calls && firstChoice.message.tool_calls.length > 0) {
                context.log(`Jarvis consultando Firebase...`);
                messages.push(firstChoice.message);
                
                for (const toolCall of firstChoice.message.tool_calls) {
                    const toolName = toolCall.function.name;
                    const toolArgs = JSON.parse(toolCall.function.arguments);
                    const result = await ejecutarHerramienta(toolName, toolArgs);
                    
                    messages.push({
                        role: "tool",
                        tool_call_id: toolCall.id,
                        name: toolName,
                        content: result
                    });
                }
                
                const finalResponse = await client.getChatCompletions(deploymentName, messages, {
                    maxTokens: 500
                });
                
                return {
                    status: 200,
                    jsonBody: { reply: finalResponse.choices[0].message.content }
                };
            }
            
            return {
                status: 200,
                jsonBody: { reply: firstChoice.message.content }
            };

        } catch (error) {
            context.error(`Error en Jarvis: ${error.message}`);
            return {
                status: 500,
                jsonBody: { error: "Error interno del servidor." }
            };
        }
    }
});
