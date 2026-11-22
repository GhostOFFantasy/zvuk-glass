const expression = process.argv.slice(2).join(' ');
if (!expression) throw new Error('Передайте выражение для Runtime.evaluate');
const pages = await fetch('http://127.0.0.1:9222/json').then((response) => response.json());
const page = pages.find((item) => item.type === 'page' && item.url.startsWith('http://tauri.localhost'));
if (!page) throw new Error('Окно приложения не найдено');
const socket = new WebSocket(page.webSocketDebuggerUrl);
const timeout = setTimeout(() => { socket.close(); throw new Error('Тайм-аут DevTools'); }, 10000);
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true });
  socket.addEventListener('error', reject, { once: true });
});
const reply = new Promise((resolve, reject) => {
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id === 1) resolve(message);
  });
  socket.addEventListener('error', reject, { once: true });
});
socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }));
const result = await reply;
clearTimeout(timeout);
socket.close();
if (result.error || result.result?.exceptionDetails) {
  console.error(JSON.stringify(result.error || result.result.exceptionDetails, null, 2));
  process.exitCode = 1;
} else {
  console.log(JSON.stringify(result.result?.result?.value ?? result.result?.result ?? null, null, 2));
}
