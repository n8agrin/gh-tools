import { expect, test } from 'bun:test';
import { refusePost } from '../src/origin';

const h = (o: Record<string, string>) => new Headers({ host: 'localhost:4790', 'content-type': 'application/json', ...o });

test("only gh-review's own pages may POST", () => {
  expect(refusePost(h({ origin: 'http://localhost:4790' }))).toBeNull();
  // From another device reaching the server by name, the page's origin matches the Host it asked.
  expect(refusePost(h({ origin: 'http://box.tail1234.ts.net:4790', host: 'box.tail1234.ts.net:4790' }))).toBeNull();
  // curl and scripts send no Origin.
  expect(refusePost(h({}))).toBeNull();
  expect(refusePost(h({ origin: 'https://evil.example' }))).toContain('refused');
  expect(refusePost(h({ origin: 'http://localhost:4791' }))).toContain('refused');
  expect(refusePost(h({ origin: 'null' }))).toContain('refused');
  // A cross-site form or no-cors fetch can only send text/plain, form or multipart bodies.
  expect(refusePost(h({ origin: 'http://localhost:4790', 'content-type': 'text/plain;charset=UTF-8' }))).toContain('application/json');
});
