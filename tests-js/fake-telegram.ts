/**
 * A stand-in for the Telegram Bot API, so the webhook tests need no token and no internet.
 *
 * It implements just the methods this app calls and records every request, the way
 * `tests/fake_telegram.py` does for the Python bot.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { writeFileSync } from "node:fs";

export interface RecordedCall {
  method: string;
  body: Record<string, unknown>;
  files: string[];
}

export interface FakeTelegram {
  url: string;
  calls: RecordedCall[];
  /** Files the "user" has sent; `getFile` maps a file_id to one of these paths. */
  files: Map<string, { path: string; name: string }>;
  close(): Promise<void>;
  callsTo(method: string): RecordedCall[];
  lastCall(method: string): RecordedCall | undefined;
}

/** Telegram returns a path relative to its file endpoint, not a local path. */
function remotePath(fileId: string, name: string): string {
  return `documents/${fileId}-${name}`;
}

export async function startFakeTelegram(files: Map<string, { path: string; name: string }>): Promise<FakeTelegram> {
  const calls: RecordedCall[] = [];

  const server: Server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks);

    // File downloads: /file/bot<token>/<path>
    if (url.pathname.startsWith("/file/bot")) {
      const filePath = decodeURIComponent(url.pathname.split("/").slice(3).join("/"));
      const entry = [...files.entries()].find(([fileId, file]) => remotePath(fileId, file.name) === filePath)?.[1];
      if (!entry) {
        response.writeHead(404).end("not found");
        return;
      }
      const { readFileSync } = await import("node:fs");
      const body = readFileSync(entry.path);
      response.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(body.length) });
      response.end(body);
      return;
    }

    const method = url.pathname.split("/").pop() ?? "";
    const contentType = request.headers["content-type"] ?? "";
    let body: Record<string, unknown> = {};
    const uploaded: string[] = [];

    if (contentType.startsWith("multipart/form-data")) {
      body = {};
      const boundary = `--${contentType.split("boundary=")[1]}`;
      const text = raw.toString("latin1");
      for (const part of text.split(boundary)) {
        const nameMatch = /name="([^"]+)"/.exec(part);
        if (!nameMatch) continue;
        const [, name] = nameMatch;
        const headerEnd = part.indexOf("\r\n\r\n");
        if (headerEnd < 0) continue;
        const value = part.slice(headerEnd + 4, part.lastIndexOf("\r\n"));
        if (part.includes("filename=")) {
          const filePath = `/tmp/fake-telegram-${Date.now()}-${name}`;
          writeFileSync(filePath, Buffer.from(value, "latin1"));
          uploaded.push(filePath);
          body[name] = `FILE:${filePath}`;
        } else {
          // Multipart text fields are UTF-8 (captions have emoji); the body was read as latin1 above.
          body[name] = Buffer.from(value, "latin1").toString("utf8");
        }
      }
    } else {
      try {
        body = raw.length ? (JSON.parse(raw.toString("utf8")) as Record<string, unknown>) : {};
      } catch {
        body = {};
      }
    }

    calls.push({ method, body, files: uploaded });

    const ok = (result: unknown) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, result }));
    };

    switch (method) {
      case "getMe":
        return ok({ id: 424242, username: "test_converter_bot", first_name: "Converter" });
      case "sendMessage":
      case "editMessageText":
      case "sendVideo":
      case "sendDocument":
      case "sendAnimation":
      case "sendAudio":
        return ok({ message_id: 1000 + calls.length, date: Math.floor(Date.now() / 1000), chat: { id: body.chat_id } });
      case "answerCallbackQuery":
        return ok(true);
      case "getFile": {
        const fileId = String(body.file_id ?? "");
        const entry = files.get(fileId);
        if (!entry) return ok({ file_id: fileId });
        return ok({ file_id: fileId, file_path: remotePath(fileId, entry.name), file_size: 0 });
      }
      case "setWebhook":
        return ok(true);
      case "deleteWebhook":
        return ok(true);
      case "getWebhookInfo":
        return ok({ url: "https://example.test/api/telegram/webhook/secret", pending_update_count: 0 });
      default:
        return ok(true);
    }
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    files,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
    callsTo(method: string) {
      return calls.filter((call) => call.method === method);
    },
    lastCall(method: string) {
      const matching = calls.filter((call) => call.method === method);
      return matching[matching.length - 1];
    },
  };
}
