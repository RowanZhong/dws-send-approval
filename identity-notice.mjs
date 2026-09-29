import { randomUUID } from "node:crypto";
import { createCardTransport } from "./card-transport.mjs";
import { COMPANY_AUTH_TITLE, COMPANY_AUTH_PARAGRAPHS, COMPANY_AUTH_TEXT } from "./identity-migration.mjs";

// This guidance is independent of the blocked business runtime and has no
// actionable callbacks. It never opens the business DB or starts a listener.
export function createIdentityNotice(config, dependencies = {}) {
  let transport, task;
  return {
    stop() { transport?.stop(); transport = undefined; },
    show() {
      if (task) return task;
      task = (async () => {
        try {
          if (!config.assistant.enabled || !config.assistant.cardTemplateId) return COMPANY_AUTH_TEXT;
          if (!transport) {
            transport = dependencies.transport ?? createCardTransport(config, () => false);
            transport.start();
          }
          const body = `${COMPANY_AUTH_PARAGRAPHS[0]}\n\n${COMPANY_AUTH_PARAGRAPHS[1]}\n\n**下一步：**<br>${COMPANY_AUTH_PARAGRAPHS[2]}`;
          await transport.sendCard({ accountId: config.accountId, ownerUserId: config.ownerUserId,
            templateId: config.assistant.cardTemplateId, outTrackId: `dws-assistant-${randomUUID()}`,
            data: { title: COMPANY_AUTH_TITLE, description: COMPANY_AUTH_PARAGRAPHS.map((s, i) => i === 2 ? `下一步：${s.replaceAll("`", "")}` : s).join("\n\n"),
              ...(config.assistant.cards.presentationVersion === 3 ? { content_status: "", content_summary: "", content_body: body, content_notice: "" } : {}),
              form: { fields: [] }, card_status: "pending", card_expires_note: "完成授权后，再次发送 /dws",
              ...Object.fromEntries(Array.from({ length: 6 }, (_, i) => [[`button${i + 1}`, ""], [`action${i + 1}`, ""]]).flat()) } });
          return "已显示公司授权更新指引。";
        } catch { return COMPANY_AUTH_TEXT; }
      })().finally(() => { task = undefined; });
      return task;
    },
  };
}
