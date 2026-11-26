import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

const files = new Map([
  ['', ['index.html', 'text/html']],
  ['index.html', ['index.html', 'text/html']],
  ['AppIcon.ico', ['../desktop/AppIcon.ico', 'image/x-icon']],
  ['scripta-logo-carved-stone.png', ['../desktop/scripta-logo-carved-stone.png', 'image/png']],
  ['style.css', ['style.css', 'text/css']],
  ['editor.js', ['editor.js', 'text/javascript']],
  ['visual-markdown.js', ['visual-markdown.js', 'text/javascript']],
  ['vendor/marked.js', ['vendor/marked.js', 'text/javascript']],
  ['vendor/purify.js', ['vendor/purify.js', 'text/javascript']],
]);
const port = Number(process.argv[2] || 4173);
const server = createServer(async (request, response) => {
  const entry = files.get(request.url.split('?')[0].slice(1));
  if (!entry) {
    response.writeHead(404).end();
    return;
  }

  try {
    const [path, type] = entry;
    const content = await readFile(new URL(path, import.meta.url));
    response.writeHead(200, { 'Content-Type': type + '; charset=utf-8', 'X-Content-Type-Options': 'nosniff' });
    response.end(content);
  } catch {
    response.writeHead(500).end();
  }
});
server.listen(port, '127.0.0.1', () => {
  console.log('Scripta 思刻 · http://127.0.0.1:' + server.address().port);
});
