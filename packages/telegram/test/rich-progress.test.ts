import { describe, expect, it, vi } from "vitest";
import { InMemoryTelegramStore, TelegramService, markdownToTelegramHtml, splitTelegramHtml, type TelegramApi } from "../src/index";

describe("Telegram rich progress", () => {
  it("escapes unsafe markdown and keeps HTML chunks valid", () => {
    const html = markdownToTelegramHtml('# **hello**\n`x < y`\n[ok](https://e.test/?a=1&b=2) [bad](javascript:alert(1))');
    expect(html).toContain("&lt; y");
    expect(html).toContain('href="https://e.test/?a=1&amp;b=2"');
    expect(html).not.toContain("javascript:");
    for (const chunk of splitTelegramHtml(`<b>${"x".repeat(5000)}</b>`)) {
      expect(chunk.length).toBeLessThanOrEqual(4096);
      expect((chunk.match(/<b>/g) ?? []).length).toBe((chunk.match(/<\/b>/g) ?? []).length);
    }
  });

  it("reserves one activity and throttles unchanged updates", async () => {
    const store = new InMemoryTelegramStore();
    const sent: any[] = [];
    const api = { sendMessage: vi.fn(async (_t, x) => { sent.push(x); return { messageId: 7 }; }), editMessageText: vi.fn(async () => {}) } as unknown as TelegramApi;
    await store.putBotConfig({ botId: "b", token: "t", telegramBotId: 1, username: "b", firstName: "b", transport: "webhook", webhookSecret: "s", createdAt: "", updatedAt: "" });
    await store.putChatBinding({ botId: "b", chatId: "c", telegramUserId: "u", createdAt: "" });
    await store.putRunDelivery({ runId: "r", botId: "b", chatId: "c", telegramUserId: "u", createdAt: "" });
    const service = new TelegramService({ store, api, now: () => 10_000 });
    expect((await Promise.all([service.deliverRunProgress({ runId: "r", text: "# hi" }), service.deliverRunProgress({ runId: "r", text: "# hi" })])).filter(x => x.sent)).toHaveLength(1);
    expect((await service.deliverRunProgress({ runId: "r", text: "# hi" })).throttled).toBe(true);
  });
});

it('keeps emoji, entities, fenced code and long nested formatting intact',()=>{
 const html=markdownToTelegramHtml('```js\nconst x = "<&";\n```\n\n**'+('🌊 & '.repeat(1800))+'**\n[Link](https://example.com/a__b?q=x&v=2)');
 const chunks=splitTelegramHtml(html);
 expect(html).toContain('<pre><code>');expect(html).not.toContain('```');
 expect(chunks.join('')).not.toContain('�');
 for(const chunk of chunks) {
  expect(chunk.length).toBeLessThanOrEqual(4096);
  expect(chunk).not.toMatch(/[\uD800-\uDBFF]$/);
  const stack:string[]=[];
  for(const tag of chunk.match(/<[^>]+>/g)??[]) {
   if(tag.startsWith('</')) expect(stack.pop()).toBe(tag.slice(2,-1));
   else stack.push(tag.match(/^<(\w+)/)![1]);
  }
  expect(stack).toEqual([]);
  expect(chunk.replace(/&(?:amp|lt|gt|quot);/g,'')).not.toContain('&');
 }
});

it('does not send to a chat after its last pairing is revoked',async()=>{
 const store=new InMemoryTelegramStore();const sendMessage=vi.fn();
 await store.putBotConfig({botId:'b',token:'secret',telegramBotId:1,username:'bot',firstName:'Bot',transport:'polling',webhookSecret:'s',createdAt:'',updatedAt:''});
 await store.putRunDelivery({runId:'r',botId:'b',chatId:'c',telegramUserId:'u',createdAt:''});
 const service=new TelegramService({store,api:{sendMessage} as any});
 expect((await service.deliverRunProgress({runId:'r',text:'Checking files'})).sent).toBe(false);
 expect((await service.deliverRunCompletion({runId:'r',status:'succeeded',output:'Done'})).sent).toBe(false);
 expect(sendMessage).not.toHaveBeenCalled();
});
