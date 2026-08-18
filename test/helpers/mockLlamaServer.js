import http from "http";

// Minimal stand-in for llama-server's OpenAI-compatible endpoints, so tests
// don't depend on a real model being loaded. `state.modelId`/`state.props`
// can be mutated between requests to change what the mock reports; requests
// are recorded in `state.requests` so tests can assert on what was sent.
export function startMockLlamaServer() {
  const state = {
    modelId: "mock-org/mock-model-7b",
    props: {
      default_generation_settings: { n_ctx: 4096 },
      total_slots: 1,
      chat_template: "{{ messages }}",
    },
    requests: [],
    chatResponse: (body) => `echo:${JSON.stringify(body.messages)}`,
  };

  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : undefined;
      state.requests.push({ method: req.method, url: req.url, body });

      if (req.method === "GET" && req.url === "/v1/models") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ data: state.modelId ? [{ id: state.modelId }] : [] }));
        return;
      }

      if (req.method === "GET" && req.url === "/props") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(state.props));
        return;
      }

      if (req.method === "POST" && req.url === "/v1/chat/completions") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            choices: [{ message: { content: state.chatResponse(body) } }],
          })
        );
        return;
      }

      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        state,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}
