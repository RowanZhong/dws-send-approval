import { randomUUID } from "node:crypto";
import { DRAFT_TOOLS, draftError } from "./assistant-draft-policy.mjs";
import { runDws } from "./assistant-dws.mjs";
const schema = (properties, required = []) => ({ type: "object", properties, required, additionalProperties: false });
const definitions = [
  { name: DRAFT_TOOLS[0], label: "近期对话", description: "读取本次起草已固定的近期对话文字，只含发送者和本人，不读取附件；不能选择其他会话。",
    parameters: schema({ limit: { type: "integer", minimum: 1, maximum: 50 } }) },
  { name: DRAFT_TOOLS[1], label: "会话双方资料", description: "读取本次会话本人或已核实发送者的姓名、部门、职位，不返回手机号或邮箱。",
    parameters: schema({ subject: { type: "string", enum: ["owner", "sender"] } }, ["subject"]) },
  { name: DRAFT_TOOLS[2], label: "检索已授权知识库", description: "在管理员指定的知识库中检索在线文档，仅返回标题与本次任务的读取句柄。",
    parameters: schema({ query: { type: "string", minLength: 1, maxLength: 120 } }, ["query"]) },
  { name: DRAFT_TOOLS[3], label: "读取检索文档", description: "读取本次检索得到的文档句柄，不能读取任意 URL、文件或其他任务的资源。",
    parameters: schema({ handle: { type: "string", pattern: "^[a-f0-9-]{36}$" } }, ["handle"]) },
];
function payload(result) {
  if (!result || result.error || result.errorCode || result.ok === false || result.success === false || result.outcome === "error") throw draftError("查询失败，请稍后重试。", "LLM_DRAFT_QUERY_FAILED");
  return result.data ?? result;
}
function contactProjection(result) {
  const data = payload(result), value = data.result ?? data;
  const rows = Array.isArray(value) ? value : value.orgEmployeeModel ? [value] : [];
  return rows.slice(0, 2).map((r) => ({ name: String(r.orgUserName ?? r.orgEmployeeModel?.orgUserName ?? r.orgEmployeeModel?.name ?? "").slice(0, 80),
    departments: (r.depts ?? r.orgEmployeeModel?.depts ?? []).map((x) => String(x.deptName ?? "").slice(0, 80)).slice(0, 5),
    title: String(r.orgEmployeeModel?.title ?? r.orgEmployeeModel?.jobTitle ?? "").slice(0, 100) }));
}
export function createDraftTools({ config, policy, contexts, runner = runDws, onQuery = () => {} }) {
  return (ctx) => {
    try { policy.task(ctx); } catch { return []; }
    return definitions.map((definition) => ({ ...definition,
      async execute(callId, params) {
        const task = policy.execute(ctx, callId, definition.name, params);
        onQuery(task.draftId);
        const data = contexts.get(ctx.sessionKey);
        if (!data) throw draftError("起草快照已失效。");
        let result;
        if (definition.name === "dws_draft_history") {
          result = { messages: data.context.slice(-(params.limit ?? 50)), status: data.contextStatus };
        } else if (definition.name === "dws_draft_contact") {
          if (params.subject === "sender" && !data.senderUserId) result = { unavailable: "无法核实发送者 UserId，未按姓名猜测身份。" };
          else {
            const args = params.subject === "owner" ? ["contact", "user", "get-self", "--format", "json"] :
              ["contact", "user", "get", "--ids", data.senderUserId, "--format", "json"];
            result = { people: contactProjection(await runner(config, args)) };
          }
        } else if (definition.name === "dws_draft_search") {
          const scopes = config.assistant.drafting.documentWorkspaceIds;
          if (!scopes.length) result = { unavailable: "管理员尚未配置可检索的知识库范围。" };
          else {
            const response = payload(await runner(config, ["doc", "+search", "--query", params.query, "--workspace-ids", scopes.join(","),
              "--extensions", "adoc", "--limit", "5", "--format", "json"]));
            let rows = response.documents;
            if (response.contractVersion !== "doc.list.v1" || !Array.isArray(rows)) throw draftError("文档检索返回结构无法核实。", "LLM_DRAFT_QUERY_FAILED");
            let titleFallback = false;
            // Newly created documents may be readable before search finds them.
            // Only supplement a successful empty search; never bypass an error.
            if (!rows.length && response.complete === true && !response.hasMore && !response.failures?.length) {
              titleFallback = true;
              const found = new Map(), query = params.query.trim().normalize("NFKC").toLowerCase();
              for (const scope of scopes.slice(0, 3)) {
                policy.active(ctx);
                const listing = payload(await runner(config, ["wiki", "node", "list", "--workspace", scope, "--limit", "50", "--format", "json"]));
                policy.active(ctx);
                if (!Array.isArray(listing.nodes)) throw draftError("知识库目录结构无法核实。", "LLM_DRAFT_QUERY_FAILED");
                for (const row of listing.nodes.slice(0, 50)) {
                  if (row.workspaceId !== scope || row.extension !== "adoc" || typeof row.name !== "string" ||
                      !row.name.normalize("NFKC").toLowerCase().includes(query)) continue;
                  found.set(row.nodeId, { nodeId: row.nodeId, docType: "adoc", name: row.name });
                  if (found.size === 5) break;
                }
                if (found.size === 5) break;
              }
              rows = [...found.values()];
            }
            const documents = []; let unverified = 0;
            for (const row of rows.slice(0, 5)) {
              if (row.docType !== "adoc" || typeof row.nodeId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(row.nodeId) || data.handles.size >= 20) { unverified++; continue; }
              // DWS search projection omits workspace identity; verify the node
              // separately before exposing even its title or issuing a handle.
              const metadata = payload(await runner(config, ["doc", "+inspect", "--node", row.nodeId, "--format", "json"]));
              policy.active(ctx);
              const info = metadata.document;
              if (info?.nodeId !== row.nodeId || !scopes.includes(info.workspaceId)) { unverified++; continue; }
              const handle = randomUUID(); data.handles.set(handle, row.nodeId);
              documents.push({ handle, title: String(row.name ?? "").slice(0, 160) });
            }
            result = { complete: response.complete === true && !unverified && !titleFallback, documents,
              ...(titleFallback ? { matching: "limited_root_titles", scopeNote: "搜索未命中，补充了部分已授权知识库根目录的标题匹配；不代表完整结果。" } : {}),
              ...(unverified ? { unavailableCount: unverified, reason: "部分资源的类型或知识库范围无法核实，未返回这些资源。" } : {}) };
          }
        } else {
          const node = data.handles.get(params.handle);
          if (!node) throw draftError("资源句柄不属于本次任务。");
          const metadata = payload(await runner(config, ["doc", "+inspect", "--node", node, "--format", "json"]));
          policy.active(ctx);
          if (metadata.document?.nodeId !== node || !config.assistant.drafting.documentWorkspaceIds.includes(metadata.document.workspaceId)) throw draftError("文档已不在本任务允许的知识库范围内。");
          const response = payload(await runner(config, ["doc", "+fetch", "--node", node, "--scope", "full", "--detail", "simple", "--format", "json"]));
          const body = response.content?.markdown;
          if (response.contractVersion !== "doc.content.v1" || typeof body !== "string") throw draftError("文档正文格式无法核实。", "LLM_DRAFT_QUERY_FAILED");
          result = { text: body.slice(0, 8000), truncated: body.length > 8000 };
        }
        // Nothing returned after an in-flight query may escape a revoked task.
        policy.active(ctx);
        const text = JSON.stringify(result);
        if (text.length > 16000) throw draftError("查询结果超出本次起草预算。");
        return { content: [{ type: "text", text }], details: { readOnly: true } };
      },
    }));
  };
}
