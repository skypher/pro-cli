import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import type { JobRecord } from "../src/jobs";
import { PAGE_SESSION_TOKEN_EXPRESSION } from "../src/session-token";
import { runChatGptJob, runChatGptResearchTask, type PageEvaluator } from "../src/transport";
import { ProError } from "../src/errors";

async function withTokenFile<T>(fn: (path: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "pro-token-test-"));
  const path = join(dir, "token.json");
  try {
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        generatedAt: new Date().toISOString(),
        source: "pro-cli-cdp-page",
        accessToken: fakeJwt(),
        accountId: "acct_test",
        expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      }),
    );
    return await fn(path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("ChatGPT transport", () => {
  test("evaluates ChatGPT frontend conversation request inside the browser page", async () => {
    await withTokenFile(async (sessionTokenPath) => {
      let cdpBase = "";
      let expression = "";
      const pageEvaluator = (async <T>(base: string, script: string): Promise<T> => {
        cdpBase = base;
        expression = script;
        return { ok: true, status: 200, body: conversationStream("OK") } as T;
      });

      const result = await runChatGptJob(job(), {
        sessionTokenPath,
        cdpBase: "http://127.0.0.1:9225",
        pageEvaluator,
      });

      expect(result).toBe("OK");
      expect(cdpBase).toBe("http://127.0.0.1:9225");
      expect(expression).toContain("https://chatgpt.com/backend-api/f/conversation");
      expect(expression).toContain("https://chatgpt.com/backend-api/f/conversation/prepare");
      expect(expression).toContain("https://chatgpt.com/backend-api/f/conversation/resume");
      expect(expression).toContain("https://chatgpt.com/backend-api/sentinel/chat-requirements/prepare");
      expect(expression).toContain("OpenAI-Sentinel-Chat-Requirements-Token");
      expect(expression).not.toContain("codex/responses");
      expect(expression).toContain('"action":"next"');
      expect(expression).toContain('"model":"gpt-5-5-pro"');
      expect(expression).toContain('"thinking_effort":"standard"');
      expect(expression).toContain('"history_and_training_disabled":true');
      expect(expression).toContain("Use terse answers.\\n\\nReply with OK only.");
      expect(expression).not.toContain("header.");
      const requestBody = requestBodyFromExpression(expression);
      expect(requestBody).toMatchObject({
        action: "next",
        model: "gpt-5-5-pro",
        thinking_effort: "standard",
        history_and_training_disabled: true,
        verbosity: "high",
        reasoning_summary: "detailed",
        tool_choice: "none",
        parallel_tools: false,
        force_parallel_switch: "none",
      });
      const messages = requestBody.messages as Array<{ content: { parts: string[] } }>;
      expect(messages[0].content.parts[0]).toBe("Use terse answers.\n\nReply with OK only.");
    });
  });

  test("omits thinking_effort for GPT-4.5 requests", async () => {
    await withTokenFile(async (sessionTokenPath) => {
      let expression = "";
      const pageEvaluator = (async <T>(_base: string, script: string): Promise<T> => {
        expression = script;
        return { ok: true, status: 200, body: conversationStream("OK") } as T;
      });

      const result = await runChatGptJob(job({ model: "gpt-4.5", reasoning: "none" }), {
        sessionTokenPath,
        pageEvaluator,
      });

      expect(result).toBe("OK");
      const requestBody = requestBodyFromExpression(expression);
      expect(requestBody.model).toBe("gpt-4-5");
      expect(requestBody).not.toHaveProperty("thinking_effort");
    });
  });

  test("uses the Deep Research connector request shape", async () => {
    await withTokenFile(async (sessionTokenPath) => {
      let expression = "";
      const pageEvaluator = (async <T>(_base: string, script: string): Promise<T> => {
        expression = script;
        return { ok: true, status: 200, body: conversationStream("OK") } as T;
      });

      const result = await runChatGptJob(job({ model: "deep-research", reasoning: "extended" }), {
        sessionTokenPath,
        pageEvaluator,
      });

      expect(result).toBe("OK");
      const requestBody = requestBodyFromExpression(expression);
      expect(requestBody.model).toBe("gpt-5-5");
      expect(requestBody).not.toHaveProperty("thinking_effort");
      expect(requestBody.system_hints).toEqual(["connector:connector_openai_deep_research"]);
      const messages = requestBody.messages as Array<{ metadata: Record<string, unknown> }>;
      expect(messages[0].metadata).toMatchObject({
        selected_sources: ["web"],
        system_hints: ["connector:connector_openai_deep_research"],
        deep_research_version: "standard",
        venus_model_variant: "standard",
      });
    });
  });

  test("uses saved ChatGPT conversations for image generation and downloads image assets", async () => {
    await withTokenFile(async (sessionTokenPath) => {
      const artifactDir = await mkdtemp(join(tmpdir(), "pro-image-artifacts-"));
      try {
        const calls: string[] = [];
        const tasks: string[] = [];
        const pageEvaluator = (async <T>(_base: string, expression: string): Promise<T> => {
          calls.push(expression);
          if (expression.includes('"method":"PATCH"') || expression.includes("is_visible")) {
            return { ok: true, status: 200 } as T;
          }
          if (expression.includes("/backend-api/conversation/")) {
            return {
              ok: true,
              status: 200,
              title: "Image generation request",
              asyncStatus: 4,
              assets: [
                {
                  fileId: "file_image_1",
                  assetPointer: "sediment://file_image_1",
                  width: 1024,
                  height: 1024,
                  sizeBytes: 9,
                  title: "Blue paper boat",
                  genId: "gen_image_1",
                },
              ],
            } as T;
          }
          if (expression.includes("/backend-api/files/download/")) {
            return {
              ok: true,
              status: 200,
              contentType: "image/png",
              bytes: 9,
              base64: Buffer.from("png-bytes").toString("base64"),
              fileName: "generated/boat.png",
            } as T;
          }
          return {
            ok: true,
            status: 200,
            body: imageLaunchStream("conversation-image"),
          } as T;
        });

        const result = await runChatGptJob(job({ model: "image", reasoning: "standard" }), {
          sessionTokenPath,
          pageEvaluator,
          artifactDir,
          onResearchTask: (task) => {
            tasks.push(task.taskId);
          },
        });

        const parsed = JSON.parse(result) as {
          type: string;
          conversationId: string;
          conversationDeleted: boolean;
          images: Array<{ path: string; fileId: string; width: number; height: number; title: string }>;
        };
        expect(parsed.type).toBe("image_generation");
        expect(parsed.conversationId).toBe("conversation-image");
        expect(parsed.conversationDeleted).toBe(true);
        expect(parsed.images).toHaveLength(1);
        expect(parsed.images[0].fileId).toBe("file_image_1");
        expect(parsed.images[0].width).toBe(1024);
        expect(parsed.images[0].height).toBe(1024);
        expect(parsed.images[0].title).toBe("Blue paper boat");
        expect(await readFile(parsed.images[0].path, "utf8")).toBe("png-bytes");
        expect(tasks).toEqual(["image:conversation-image"]);

        const requestBody = requestBodyFromExpression(calls[0]);
        expect(requestBody.model).toBe("gpt-5-6-pro");
        const patchCall = calls.find((call) => call.includes("is_visible"));
        expect(patchCall).toBeDefined();
        expect(requestBody.history_and_training_disabled).toBeUndefined();
        expect((requestBody.messages as Array<{ content: { parts: string[] } }>)[0].content.parts[0])
          .toContain("Use ChatGPT image generation tools");
      } finally {
        await rm(artifactDir, { recursive: true, force: true });
      }
    });
  });

  test("keeps the image conversation when keepImageConversation is set", async () => {
    await withTokenFile(async (sessionTokenPath) => {
      const artifactDir = await mkdtemp(join(tmpdir(), "pro-image-keep-"));
      try {
        const calls: string[] = [];
        const pageEvaluator = (async <T>(_base: string, expression: string): Promise<T> => {
          calls.push(expression);
          if (expression.includes("is_visible")) {
            throw new Error("Cleanup PATCH must not run with keepImageConversation.");
          }
          if (expression.includes("/backend-api/conversation/")) {
            return {
              ok: true,
              status: 200,
              title: "Kept image",
              asyncStatus: 4,
              assets: [
                {
                  fileId: "file_kept_image",
                  assetPointer: "sediment://file_kept_image",
                  width: 512,
                  height: 512,
                  sizeBytes: 4,
                  title: "Kept image",
                  genId: "gen_kept",
                },
              ],
            } as T;
          }
          if (expression.includes("/backend-api/files/download/")) {
            return {
              ok: true,
              status: 200,
              contentType: "image/png",
              bytes: 4,
              base64: Buffer.from("keep").toString("base64"),
              fileName: "kept.png",
            } as T;
          }
          return { ok: true, status: 200, body: imageLaunchStream("conversation-kept") } as T;
        });

        const result = await runChatGptJob(job({ model: "image", reasoning: "standard" }), {
          sessionTokenPath,
          pageEvaluator,
          artifactDir,
          keepImageConversation: true,
        });

        const parsed = JSON.parse(result) as { conversationDeleted: boolean };
        expect(parsed.conversationDeleted).toBe(false);
        expect(calls.some((call) => call.includes("is_visible"))).toBe(false);
      } finally {
        await rm(artifactDir, { recursive: true, force: true });
      }
    });
  });

  test("uploads attachments, sends multimodal parts, and excludes uploads from image results", async () => {
    await withTokenFile(async (sessionTokenPath) => {
      const artifactDir = await mkdtemp(join(tmpdir(), "pro-image-attach-"));
      try {
        const attachmentPath = join(artifactDir, "source.png");
        await writeFile(attachmentPath, "source-bytes");
        const calls: string[] = [];
        const pageEvaluator = (async <T>(_base: string, expression: string): Promise<T> => {
          calls.push(expression);
          if (expression.includes("use_case")) {
            return {
              ok: true,
              step: "done",
              status: 200,
              fileId: "file_upload_1",
              width: 640,
              height: 480,
              error: null,
            } as T;
          }
          if (expression.includes("is_visible")) {
            return { ok: true, status: 200 } as T;
          }
          if (expression.includes("/backend-api/conversation/")) {
            return {
              ok: true,
              status: 200,
              title: "Edited image",
              asyncStatus: 4,
              assets: [
                {
                  fileId: "file_upload_1",
                  assetPointer: "file-service://file_upload_1",
                  width: 640,
                  height: 480,
                  sizeBytes: 12,
                  title: null,
                  genId: null,
                },
                {
                  fileId: "file_edited_1",
                  assetPointer: "sediment://file_edited_1",
                  width: 1024,
                  height: 1024,
                  sizeBytes: 6,
                  title: "Edited",
                  genId: "gen_edited",
                },
              ],
            } as T;
          }
          if (expression.includes("/backend-api/files/download/")) {
            return {
              ok: true,
              status: 200,
              contentType: "image/png",
              bytes: 6,
              base64: Buffer.from("edited").toString("base64"),
              fileName: "edited.png",
            } as T;
          }
          return { ok: true, status: 200, body: imageLaunchStream("conversation-edit") } as T;
        });

        const editJob = job({ model: "image", reasoning: "standard" });
        editJob.options.attachments = [
          { path: attachmentPath, name: "source.png", mimeType: "image/png" },
        ];
        const result = await runChatGptJob(editJob, {
          sessionTokenPath,
          pageEvaluator,
          artifactDir,
        });

        const parsed = JSON.parse(result) as {
          conversationDeleted: boolean;
          images: Array<{ fileId: string }>;
        };
        expect(parsed.images).toHaveLength(1);
        expect(parsed.images[0].fileId).toBe("file_edited_1");
        expect(parsed.conversationDeleted).toBe(true);

        const submission = calls.find((call) => call.includes("/backend-api/f/conversation"));
        expect(submission).toBeDefined();
        const requestBody = requestBodyFromExpression(submission ?? "");
        const message = (requestBody.messages as Array<{
          content: { content_type: string; parts: Array<unknown> };
          metadata: { attachments?: Array<Record<string, unknown>> };
        }>)[0];
        expect(message.content.content_type).toBe("multimodal_text");
        expect(message.content.parts[0]).toMatchObject({
          content_type: "image_asset_pointer",
          asset_pointer: "file-service://file_upload_1",
          width: 640,
          height: 480,
        });
        expect(typeof message.content.parts[1]).toBe("string");
        expect(message.metadata.attachments).toEqual([
          {
            id: "file_upload_1",
            name: "source.png",
            size: 12,
            mime_type: "image/png",
            width: 640,
            height: 480,
          },
        ]);
      } finally {
        await rm(artifactDir, { recursive: true, force: true });
      }
    });
  });

  test("resumes a persisted image task without submitting a new conversation", async () => {
    await withTokenFile(async (sessionTokenPath) => {
      const artifactDir = await mkdtemp(join(tmpdir(), "pro-image-resume-"));
      try {
        const calls: string[] = [];
        const pageEvaluator = (async <T>(_base: string, expression: string): Promise<T> => {
          calls.push(expression);
          if (expression.includes("/backend-api/conversation/")) {
            return {
              ok: true,
              status: 200,
              title: "Resumed image",
              asyncStatus: 4,
              assets: [
                {
                  fileId: "file_resumed_image",
                  assetPointer: "sediment://file_resumed_image",
                  width: 512,
                  height: 512,
                  sizeBytes: 7,
                  title: "Resumed image",
                  genId: "gen_resumed",
                },
              ],
            } as T;
          }
          if (expression.includes("/backend-api/files/download/")) {
            return {
              ok: true,
              status: 200,
              contentType: "image/png",
              bytes: 7,
              base64: Buffer.from("resume!").toString("base64"),
              fileName: "resumed.png",
            } as T;
          }
          throw new Error("Unexpected conversation submission.");
        });

        const result = await runChatGptResearchTask(
          { taskId: "image:conversation-resume", conversationId: "conversation-resume", title: "Resumed image" },
          { sessionTokenPath, pageEvaluator, artifactDir },
        );

        const parsed = JSON.parse(result) as { images: Array<{ path: string; fileId: string }> };
        expect(parsed.images[0].fileId).toBe("file_resumed_image");
        expect(await readFile(parsed.images[0].path, "utf8")).toBe("resume!");
        expect(calls.some((call) => call.includes("/backend-api/f/conversation"))).toBe(false);
      } finally {
        await rm(artifactDir, { recursive: true, force: true });
      }
    });
  });

  test("rejects Deep Research acknowledgement-only responses as incomplete", async () => {
    await withTokenFile(async (sessionTokenPath) => {
      const acknowledgement = [
        "Understood. I'll conduct a deep, price-blind analysis comparing Stripe's private/public valuation outlook versus American Express's public market cap by December 31, 2026.",
        "",
        "This includes:",
        "- Stripe's likely valuation trajectory",
        "- American Express's valuation drivers",
        "- Resolution edge cases",
        "",
        "I'll return with a structured deep research report shortly.",
      ].join("\n");
      const pageEvaluator = (async <T>(): Promise<T> =>
        ({ ok: true, status: 200, body: conversationStream(acknowledgement) }) as T);

      try {
        await runChatGptJob(job({ model: "research", reasoning: "extended" }), {
          sessionTokenPath,
          pageEvaluator,
        });
        throw new Error("Expected INCOMPLETE_RESEARCH_ACK.");
      } catch (error) {
        expect(error).toBeInstanceOf(ProError);
        const proError = error as ProError;
        expect(proError.code).toBe("INCOMPLETE_RESEARCH_ACK");
        expect(proError.message).toContain("acknowledgement");
        expect(proError.suggestions.join("\n")).toContain("gpt-5-5-pro");
        expect(proError.details?.model).toBe("research");
        expect(proError.details?.chars).toBe(acknowledgement.length);
      }
    });
  });

  test("returns completed Deep Research artifacts normally", async () => {
    await withTokenFile(async (sessionTokenPath) => {
      const report = [
        "Executive summary",
        "Stripe is the underdog but has a plausible right-tail path.",
        "",
        "Findings",
        "1. Stripe private-market signals remain below AXP's current market cap.",
        "2. AXP multiple compression is the main path for a Stripe win.",
        "",
        "Sources",
        "- Nasdaq Private Market",
        "- American Express investor relations",
      ].join("\n");
      const pageEvaluator = (async <T>(): Promise<T> =>
        ({ ok: true, status: 200, body: conversationStream(report) }) as T);

      const result = await runChatGptJob(job({ model: "research", reasoning: "extended" }), {
        sessionTokenPath,
        pageEvaluator,
      });

      expect(result).toBe(report);
    });
  });

  test("polls Deep Research async tasks and returns the final task message", async () => {
    await withTokenFile(async (sessionTokenPath) => {
      let taskCalls = 0;
      const launchedTasks: string[] = [];
      const statuses: string[] = [];
      const pageEvaluator = (async <T>(_base: string, expression: string): Promise<T> => {
        if (expression.includes("/backend-api/task/")) {
          taskCalls += 1;
          return {
            ok: true,
            status: 200,
            body: {
              status: "completed",
              final_message: {
                author: { role: "assistant" },
                content: { content_type: "text", parts: ["Final Deep Research report."] },
                status: "finished_successfully",
              },
            },
          } as T;
        }
        return {
          ok: true,
          status: 200,
          body: researchLaunchStream("deepresch_test", "I'll return with a structured deep research report shortly."),
        } as T;
      });

      const result = await runChatGptJob(job({ model: "research", reasoning: "extended" }), {
        sessionTokenPath,
        pageEvaluator,
        onResearchTask: (task) => {
          launchedTasks.push(task.taskId);
        },
        onResearchTaskStatus: (update) => {
          statuses.push(update.status);
        },
      });

      expect(result).toBe("Final Deep Research report.");
      expect(taskCalls).toBe(1);
      expect(launchedTasks).toEqual(["deepresch_test"]);
      expect(statuses).toEqual(["completed"]);
    });
  });

  test("polls Deep Research connector widget state and returns the final report", async () => {
    await withTokenFile(async (sessionTokenPath) => {
      const calls: string[] = [];
      const launchedTasks: string[] = [];
      const statuses: string[] = [];
      const pageEvaluator = (async <T>(_base: string, expression: string): Promise<T> => {
        calls.push(expression);
        if (expression.includes("/backend-api/conversation/")) {
          return {
            ok: true,
            status: 200,
            statusText: "completed",
            title: "Connector research",
            finalText: "Final connector report.",
          } as T;
        }
        return {
          ok: true,
          status: 200,
          body: deepResearchWidgetLaunchStream("conversation-widget", "widget-session-1"),
        } as T;
      });

      const result = await runChatGptJob(job({ model: "research", reasoning: "extended" }), {
        sessionTokenPath,
        pageEvaluator,
        onResearchTask: (task) => {
          launchedTasks.push(task.taskId);
        },
        onResearchTaskStatus: (update) => {
          statuses.push(update.status);
        },
      });

      expect(result).toBe("Final connector report.");
      expect(launchedTasks).toEqual(["widget-session-1"]);
      expect(statuses).toEqual(["completed"]);
      expect(calls.some((call) => call.includes("/backend-api/conversation/"))).toBe(true);
      expect(calls.some((call) => call.includes("/backend-api/task/"))).toBe(false);
    });
  });

  test("polls Deep Research connector widgets when the launch stream has no assistant text", async () => {
    await withTokenFile(async (sessionTokenPath) => {
      const launchedTasks: string[] = [];
      const pageEvaluator = (async <T>(_base: string, expression: string): Promise<T> => {
        if (expression.includes("/backend-api/conversation/")) {
          return {
            ok: true,
            status: 200,
            statusText: "completed",
            title: "Connector research",
            finalText: "Final report after metadata-only launch.",
          } as T;
        }
        return {
          ok: true,
          status: 200,
          body: deepResearchWidgetToolOnlyLaunchStream("conversation-widget", "widget-session-1"),
        } as T;
      });

      const result = await runChatGptJob(job({ model: "research", reasoning: "extended" }), {
        sessionTokenPath,
        pageEvaluator,
        onResearchTask: (task) => {
          launchedTasks.push(task.taskId);
        },
      });

      expect(result).toBe("Final report after metadata-only launch.");
      expect(launchedTasks).toEqual(["widget-session-1"]);
    });
  });

  test("resumes polling a persisted Deep Research connector widget without submitting a new conversation", async () => {
    await withTokenFile(async (sessionTokenPath) => {
      const expressions: string[] = [];
      const pageEvaluator = (async <T>(_base: string, expression: string): Promise<T> => {
        expressions.push(expression);
        expect(expression).toContain("/backend-api/conversation/");
        return {
          ok: true,
          status: 200,
          statusText: "completed",
          title: "Persisted connector research",
          finalText: "Recovered connector report.",
        } as T;
      });

      const result = await runChatGptResearchTask(
        { taskId: "widget-session-2", title: "Persisted connector research", conversationId: "conversation-widget" },
        { sessionTokenPath, pageEvaluator },
      );

      expect(result).toBe("Recovered connector report.");
      expect(expressions).toHaveLength(1);
      expect(expressions[0]).not.toContain("/backend-api/f/conversation");
      expect(expressions[0]).not.toContain("/backend-api/task/");
    });
  });

  test("continues Deep Research connector widget polling after a transient CDP timeout", async () => {
    await withTokenFile(async (sessionTokenPath) => {
      let attempts = 0;
      const pageEvaluator = (async <T>(): Promise<T> => {
        attempts += 1;
        if (attempts === 1) {
          throw new ProError("CDP_TIMEOUT", "Chrome CDP command Runtime.evaluate timed out.");
        }
        return {
          ok: true,
          status: 200,
          statusText: "completed",
          title: "Connector timeout recovery",
          finalText: "Recovered connector report after CDP timeout.",
        } as T;
      });

      const result = await runChatGptResearchTask(
        { taskId: "widget-session-timeout", title: "Timeout recovery", conversationId: "conversation-widget" },
        { sessionTokenPath, pageEvaluator, timeoutMs: 50 },
      );

      expect(result).toBe("Recovered connector report after CDP timeout.");
      expect(attempts).toBe(2);
    });
  });

  test("backs off and continues Deep Research connector widget polling after HTTP 429", async () => {
    await withTokenFile(async (sessionTokenPath) => {
      let attempts = 0;
      const statuses: string[] = [];
      const pageEvaluator = (async <T>(): Promise<T> => {
        attempts += 1;
        if (attempts === 1) {
          return {
            ok: false,
            status: 429,
            statusText: null,
            title: null,
            finalText: null,
            preview: '{"detail":"Too many requests"}',
          } as T;
        }
        return {
          ok: true,
          status: 200,
          statusText: "completed",
          title: "Connector rate-limit recovery",
          finalText: "Recovered connector report after rate limit.",
        } as T;
      });

      const result = await runChatGptResearchTask(
        { taskId: "widget-session-rate-limited", title: "Rate-limit recovery", conversationId: "conversation-widget" },
        {
          sessionTokenPath,
          pageEvaluator,
          timeoutMs: 50,
          onResearchTaskStatus: (update) => {
            statuses.push(update.status);
          },
        },
      );

      expect(result).toBe("Recovered connector report after rate limit.");
      expect(attempts).toBe(2);
      expect(statuses).toEqual(["rate_limited", "completed"]);
    });
  });

  test("resumes polling a persisted Deep Research async task without submitting a new conversation", async () => {
    await withTokenFile(async (sessionTokenPath) => {
      const expressions: string[] = [];
      const pageEvaluator = (async <T>(_base: string, expression: string): Promise<T> => {
        expressions.push(expression);
        expect(expression).toContain("/backend-api/task/");
        return {
          ok: true,
          status: 200,
          body: {
            status: "completed",
            final_message: {
              author: { role: "assistant" },
              content: { content_type: "text", parts: ["Recovered final report."] },
              status: "finished_successfully",
            },
          },
        } as T;
      });

      const result = await runChatGptResearchTask(
        { taskId: "deepresch_persisted", title: "Persisted research" },
        { sessionTokenPath, pageEvaluator },
      );

      expect(result).toBe("Recovered final report.");
      expect(expressions).toHaveLength(1);
      expect(expressions[0]).not.toContain("/backend-api/f/conversation");
    });
  });

  test("continues Deep Research polling after a transient CDP timeout", async () => {
    await withTokenFile(async (sessionTokenPath) => {
      let attempts = 0;
      const pageEvaluator = (async <T>(): Promise<T> => {
        attempts += 1;
        if (attempts === 1) {
          throw new ProError("CDP_TIMEOUT", "Chrome CDP command Runtime.evaluate timed out.");
        }
        return {
          ok: true,
          status: 200,
          body: {
            status: "completed",
            final_message: {
              author: { role: "assistant" },
              content: { content_type: "text", parts: ["Recovered after CDP timeout."] },
              status: "finished_successfully",
            },
          },
        } as T;
      });

      const result = await runChatGptResearchTask(
        { taskId: "deepresch_timeout", title: "Timeout recovery" },
        { sessionTokenPath, pageEvaluator, timeoutMs: 5 },
      );

      expect(result).toBe("Recovered after CDP timeout.");
      expect(attempts).toBe(2);
    });
  });

  test("recovers Deep Research task metadata from the saved conversation when the stream omits it", async () => {
    await withTokenFile(async (sessionTokenPath) => {
      const calls: string[] = [];
      const pageEvaluator = (async <T>(_base: string, expression: string): Promise<T> => {
        calls.push(expression);
        if (expression.includes("/backend-api/conversation/")) {
          return {
            ok: true,
            status: 200,
            task: {
              taskId: "deepresch_from_conversation",
              title: "Recovered research task",
              conversationId: "async-conversation",
            },
          } as T;
        }
        if (expression.includes("/backend-api/task/")) {
          return {
            ok: true,
            status: 200,
            body: {
              status: "completed",
              final_message: {
                author: { role: "assistant" },
                content: { content_type: "text", parts: ["Recovered report."] },
                status: "finished_successfully",
              },
            },
          } as T;
        }
        return {
          ok: true,
          status: 200,
          body: researchAckConversationStream("conversation-1", "I'll return with the report shortly."),
        } as T;
      });

      const result = await runChatGptJob(job({ model: "research", reasoning: "extended" }), {
        sessionTokenPath,
        pageEvaluator,
      });

      expect(result).toBe("Recovered report.");
      expect(calls.some((call) => call.includes("/backend-api/conversation/"))).toBe(true);
      expect(calls.some((call) => call.includes("/backend-api/task/"))).toBe(true);
    });
  });

  test("recovers Deep Research task metadata when the acknowledgement is wrapped in research JSON", async () => {
    await withTokenFile(async (sessionTokenPath) => {
      const calls: string[] = [];
      const acknowledgementEnvelope = JSON.stringify({
        task_violates_safety_guidelines: false,
        user_def_doesnt_want_research: false,
        response: "Understood. I'll begin deep research now and get back to you shortly.",
        title: "Ceasefire research",
        prompt: "Conduct a price-blind deep analysis.",
      });
      const pageEvaluator = (async <T>(_base: string, expression: string): Promise<T> => {
        calls.push(expression);
        if (expression.includes("/backend-api/conversation/")) {
          return {
            ok: true,
            status: 200,
            task: {
              taskId: "deepresch_json_envelope",
              title: "Recovered JSON-envelope research task",
            },
          } as T;
        }
        if (expression.includes("/backend-api/task/")) {
          return {
            ok: true,
            status: 200,
            body: {
              status: "completed",
              final_message: {
                author: { role: "assistant" },
                content: { content_type: "text", parts: ["Recovered JSON-envelope report."] },
                status: "finished_successfully",
              },
            },
          } as T;
        }
        return {
          ok: true,
          status: 200,
          body: researchAckConversationStream("conversation-2", acknowledgementEnvelope),
        } as T;
      });

      const result = await runChatGptJob(job({ model: "research", reasoning: "extended" }), {
        sessionTokenPath,
        pageEvaluator,
      });

      expect(result).toBe("Recovered JSON-envelope report.");
      expect(calls.some((call) => call.includes("/backend-api/conversation/"))).toBe(true);
      expect(calls.some((call) => call.includes("/backend-api/task/"))).toBe(true);
    });
  });

  test("keeps Deep Research async tasks non-successful while the task is still running", async () => {
    await withTokenFile(async (sessionTokenPath) => {
      const pageEvaluator = (async <T>(_base: string, expression: string): Promise<T> => {
        if (expression.includes("/backend-api/task/")) {
          return {
            ok: true,
            status: 200,
            body: { status: "running", task_id: "deepresch_test", final_message: null, messages: [] },
          } as T;
        }
        return {
          ok: true,
          status: 200,
          body: researchLaunchStream("deepresch_test", "I'll return with a structured deep research report shortly."),
        } as T;
      });

      try {
        await runChatGptJob(job({ model: "research", reasoning: "extended" }), {
          sessionTokenPath,
          pageEvaluator,
          timeoutMs: 1,
        });
        throw new Error("Expected RESEARCH_TASK_INCOMPLETE.");
      } catch (error) {
        expect(error).toBeInstanceOf(ProError);
        const proError = error as ProError;
        expect(proError.code).toBe("RESEARCH_TASK_INCOMPLETE");
        expect(proError.details?.taskId).toBe("deepresch_test");
        expect(proError.details?.status).toBe("running");
      }
    });
  });

  test("retries transient upstream failures", async () => {
    await withTokenFile(async (sessionTokenPath) => {
      let attempts = 0;
      const pageEvaluator = (async <T>(): Promise<T> => {
        attempts += 1;
        if (attempts === 1) return { ok: false, status: 503, body: "busy" } as T;
        return { ok: true, status: 200, body: conversationStream("OK") } as T;
      });

      const result = await runChatGptJob(job(), {
        sessionTokenPath,
        pageEvaluator,
        retries: 1,
        retryDelayMs: 0,
      });

      expect(result).toBe("OK");
      expect(attempts).toBe(2);
    });
  });

  test("retries incomplete response streams", async () => {
    await withTokenFile(async (sessionTokenPath) => {
      let attempts = 0;
      const pageEvaluator = (async <T>(): Promise<T> => {
        attempts += 1;
        if (attempts === 1) {
          return {
            ok: true,
            status: 200,
            body: 'data: {"message":{"author":{"role":"assistant"},"content":{"content_type":"text","parts":["partial"]},"status":"in_progress"}}\n\n',
          } as T;
        }
        return { ok: true, status: 200, body: conversationStream("OK") } as T;
      });

      const result = await runChatGptJob(job(), {
        sessionTokenPath,
        pageEvaluator,
        retries: 1,
        retryDelayMs: 0,
      });

      expect(result).toBe("OK");
      expect(attempts).toBe(2);
    });
  });

  test("accepts streams that only mark completion with DONE", async () => {
    await withTokenFile(async (sessionTokenPath) => {
      const pageEvaluator = (async <T>(): Promise<T> =>
        ({
          ok: true,
          status: 200,
          body: [
            'data: {"message":{"author":{"role":"assistant"},"content":{"content_type":"text","parts":["OK"]},"status":"in_progress"}}',
            "data: [DONE]",
            "",
          ].join("\n\n"),
        }) as T);

      const result = await runChatGptJob(job(), { sessionTokenPath, pageEvaluator });

      expect(result).toBe("OK");
    });
  });

  test("reads CRLF-delimited SSE frames from upstream streams", async () => {
    await withTokenFile(async (sessionTokenPath) => {
      const pageEvaluator = (async <T>(): Promise<T> =>
        ({
          ok: true,
          status: 200,
          body: conversationStream("OK").replace(/\n/g, "\r\n"),
        }) as T);

      const result = await runChatGptJob(job(), { sessionTokenPath, pageEvaluator });

      expect(result).toBe("OK");
    });
  });

  test("surfaces upstream error events instead of treating DONE as success", async () => {
    await withTokenFile(async (sessionTokenPath) => {
      const pageEvaluator = (async <T>(): Promise<T> =>
        ({
          ok: true,
          status: 200,
          body: [
            'data: {"type":"error","error":{"message":"usage limit reached"}}',
            "data: [DONE]",
            "",
          ].join("\n\n"),
        }) as T);

      try {
        await runChatGptJob(job(), { sessionTokenPath, pageEvaluator });
        throw new Error("Expected UPSTREAM_ERROR.");
      } catch (error) {
        expect(error).toBeInstanceOf(ProError);
        const proError = error as ProError;
        expect(proError.code).toBe("UPSTREAM_ERROR");
        expect(proError.message).toBe("usage limit reached");
        expect(proError.details?.attempts).toBe(1);
      }
    });
  });

  test("empty completed responses tell agents not to spend quota on probes", async () => {
    await withTokenFile(async (sessionTokenPath) => {
      const pageEvaluator = (async <T>(): Promise<T> =>
        ({
          ok: true,
          status: 200,
          body: ["data: [DONE]", ""].join("\n\n"),
        }) as T);

      try {
        await runChatGptJob(job(), { sessionTokenPath, pageEvaluator });
        throw new Error("Expected EMPTY_RESPONSE.");
      } catch (error) {
        expect(error).toBeInstanceOf(ProError);
        const proError = error as ProError;
        const suggestions = proError.suggestions.join("\n").toLowerCase();
        expect(proError.code).toBe("EMPTY_RESPONSE");
        expect(suggestions).toContain("same real request");
        expect(suggestions).toContain("smoke-test");
        expect(suggestions).toContain("pro-cli doctor --json");
      }
    });
  });

  test("reads patch-style /f/conversation streams", async () => {
    await withTokenFile(async (sessionTokenPath) => {
      const pageEvaluator = (async <T>(): Promise<T> =>
        ({
          ok: true,
          status: 200,
          body: [
            'data: {"v":{"message":{"author":{"role":"assistant"},"content":{"content_type":"text","parts":[""]},"status":"in_progress"}}}',
            'data: {"o":"patch","v":[{"p":"/message/content/parts/0","o":"append","v":"O"},{"p":"/message/content/parts/0","o":"append","v":"K"}]}',
            'data: {"type":"message_stream_complete"}',
            "",
          ].join("\n\n"),
        }) as T);

      const result = await runChatGptJob(job(), { sessionTokenPath, pageEvaluator });

      expect(result).toBe("OK");
    });
  });

  test("reads resumed handoff streams appended after the initial response", async () => {
    await withTokenFile(async (sessionTokenPath) => {
      const pageEvaluator = (async <T>(): Promise<T> =>
        ({
          ok: true,
          status: 200,
          body: [
            'data: {"type":"resume_conversation_token","token":"resume_token","conversation_id":"conv_test"}',
            'data: {"type":"stream_handoff","conversation_id":"conv_test"}',
            "data: [DONE]",
            "",
            'data: {"o":"patch","v":[{"p":"/message/content/parts/0","o":"append","v":"O"},{"p":"/message/content/parts/0","o":"append","v":"K"}]}',
            'data: {"type":"message_stream_complete"}',
            "",
          ].join("\n\n"),
        }) as T);

      const result = await runChatGptJob(job(), { sessionTokenPath, pageEvaluator });

      expect(result).toBe("OK");
    });
  });

  test("keeps accumulated patch text when final snapshots contain only a suffix", async () => {
    await withTokenFile(async (sessionTokenPath) => {
      const pageEvaluator = (async <T>(): Promise<T> =>
        ({
          ok: true,
          status: 200,
          body: [
            'data: {"v":{"message":{"author":{"role":"assistant"},"content":{"content_type":"text","parts":[""]},"status":"in_progress"}}}',
            'data: {"p":"/message/content/parts/0","o":"append","v":"Open Chrome. "}',
            'data: {"v":"Run jobs. "}',
            'data: {"v":"Close it when done."}',
            'data: {"message":{"author":{"role":"assistant"},"content":{"content_type":"text","parts":["Close it when done."]},"status":"finished_successfully"}}',
            'data: {"type":"message_stream_complete"}',
            "",
          ].join("\n\n"),
        }) as T);

      const result = await runChatGptJob(job(), { sessionTokenPath, pageEvaluator });

      expect(result).toBe("Open Chrome. Run jobs. Close it when done.");
    });
  });

  test("keeps repeated chunks and chunks that match the end of the text", async () => {
    await withTokenFile(async (sessionTokenPath) => {
      const pageEvaluator = (async <T>(): Promise<T> =>
        ({
          ok: true,
          status: 200,
          body: [
            'data: {"v":{"message":{"author":{"role":"assistant"},"content":{"content_type":"text","parts":[""]},"status":"in_progress"}}}',
            'data: {"p":"/message/content/parts/0","o":"append","v":"OK"}',
            'data: {"v":"OK"}',
            'data: {"v":"\\n"}',
            'data: {"v":"\\n"}',
            'data: {"v":"| a |"}',
            'data: {"v":" |"}',
            'data: {"type":"message_stream_complete"}',
            "",
          ].join("\n\n"),
        }) as T);

      const result = await runChatGptJob(job(), { sessionTokenPath, pageEvaluator });

      expect(result).toBe("OKOK\n\n| a | |");
    });
  });

  test("reads answer text sent in patch continuation frames", async () => {
    await withTokenFile(async (sessionTokenPath) => {
      const body = [
        'event: delta_encoding\ndata: "v1"',
        'event: delta\ndata: {"p":"","o":"add","v":{"message":{"id":"m1","author":{"role":"assistant"},"channel":"final","recipient":"all","content":{"content_type":"text","parts":[""]},"status":"in_progress"},"conversation_id":"conv_patch"},"c":3}',
        'event: delta\ndata: {"o":"patch","v":[{"p":"/message/content/parts/0","o":"append","v":"One"},{"p":"/message/metadata/content_references","o":"append","v":[]}]}',
        'event: delta\ndata: {"v":[{"p":"/message/content/parts/0","o":"append","v":" two"}]}',
        'data: {"type":"url_moderation","conversation_id":"conv_patch"}',
        'event: delta\ndata: {"v":[{"p":"/message/content/parts/0","o":"append","v":" three."},{"p":"/message/status","o":"replace","v":"finished_successfully"},{"p":"/message/end_turn","o":"replace","v":true}]}',
        'data: {"type":"message_stream_complete","conversation_id":"conv_patch"}',
        "data: [DONE]",
        "",
      ].join("\n\n");
      const pageEvaluator = (async <T>(): Promise<T> => ({ ok: true, status: 200, body }) as T);

      expect(await runChatGptJob(job(), { sessionTokenPath, pageEvaluator })).toBe("One two three.");
    });
  });

  test("takes the joined answer once when a fast model streams it twice and the hand-off replays it", async () => {
    await withTokenFile(async (sessionTokenPath) => {
      const assistant = (id: string, c: number) =>
        `event: delta\ndata: {"v":{"message":{"id":"${id}","author":{"role":"assistant"},"channel":"final","recipient":"all","content":{"content_type":"text","parts":[""]},"status":"in_progress"},"conversation_id":"conv_fast"},"c":${c}}`;
      const append = (c: number, text: string) =>
        `event: delta\ndata: {"c":${c},"o":"patch","v":[{"p":"/message/content/parts/0","o":"append","v":${JSON.stringify(text)}}]}`;
      const finish = (c: number, endTurn: boolean) =>
        `event: delta\ndata: {"c":${c},"v":[{"p":"/message/status","o":"replace","v":"finished_successfully"},{"p":"/message/end_turn","o":"replace","v":${endTurn}}]}`;
      const segment = [
        'event: delta_encoding\ndata: "v1"',
        'event: delta\ndata: {"p":"","o":"add","v":{"message":{"id":"u","author":{"role":"user"},"content":{"content_type":"text","parts":["question"]},"status":"finished_successfully"},"conversation_id":"conv_fast"},"c":0}',
        assistant("first-search", 1),
        assistant("joined", 2),
        append(1, "Bun 1.4.3 is out. "),
        append(2, "Bun 1.4.3 is out. "),
        finish(1, false),
        `event: delta\ndata: {"p":"","o":"add","v":{"message":{"id":"second-search","author":{"role":"assistant"},"channel":"final","recipient":"all","content":{"content_type":"text","parts":[""]},"status":"in_progress"},"conversation_id":"conv_fast"},"c":3}`,
        'data: {"type":"streaming_parent_patch","conversation_id":"conv_fast","logical_answer_id":"joined","revision":1,"updates":[]}',
        append(3, "It checks types."),
        append(2, "It checks types."),
        finish(3, true),
        finish(2, true),
        'data: {"type":"message_stream_complete","conversation_id":"conv_fast"}',
        "data: [DONE]",
      ];
      const body = [...segment, ...segment, ""].join("\n\n");
      const pageEvaluator = (async <T>(): Promise<T> => ({ ok: true, status: 200, body }) as T);

      expect(await runChatGptJob(job(), { sessionTokenPath, pageEvaluator })).toBe("Bun 1.4.3 is out. It checks types.");
    });
  });

  describe("citations", () => {
    const cite = "\ue200cite\ue202turn0search0\ue202turn0search1\ue201";
    const genui = '\ue200genui\ue202{"citation":{"ref":"turn1view0"}}\ue201';
    const answer = [
      `Bun 1.4.3 is out. ${cite}`,
      'It checks types. <Cite refs={["turn0view0"]}/>',
      `Also fast. ${genui}`,
      'Notes: <Link url="https://bun.com/blog/bun-v1.4.3?utm_source=chatgpt.com" title="Release notes"/>',
      "Unknown: \ue200cite\ue202turn9search9\ue201 end.",
    ].join("\n");
    const searchResult = (turn: number, type: string, index: number, url: string, title: string) =>
      ({ type: "search_result", url, title, ref_id: { turn_index: turn, ref_type: type, ref_index: index } });
    const body = [
      'event: delta_encoding\ndata: "v1"',
      'event: delta\ndata: {"p":"","o":"add","v":{"message":{"id":"a","author":{"role":"assistant"},"channel":"final","recipient":"all","content":{"content_type":"text","parts":[""]},"status":"in_progress"},"conversation_id":"conv_cite"},"c":5}',
      `event: delta\ndata: ${JSON.stringify({ o: "patch", v: [{ p: "/message/content/parts/0", o: "append", v: answer }] })}`,
      `event: delta\ndata: ${JSON.stringify({ v: [
        { p: "/message/status", o: "replace", v: "finished_successfully" },
        { p: "/message/end_turn", o: "replace", v: true },
        { p: "/message/metadata/content_references", o: "append", v: [{
          matched_text: genui,
          type: "grouped_webpages",
          items: [{ title: "Bun v1.4.3 | Bun Blog", url: "https://bun.com/blog/bun-v1.4.3", refs: [{ turn_index: 1, ref_type: "view", ref_index: 0 }] }],
        }] },
        { p: "/message/metadata", o: "append", v: { search_result_groups: [{ type: "search_result_group", entries: [
          searchResult(0, "search", 0, "https://github.com/oven-sh/bun/releases?utm_source=chatgpt.com", "Releases"),
          searchResult(0, "search", 1, "https://bun.com/blog", "Blog"),
          searchResult(0, "view", 0, "https://bun.com/blog/bun-v1.4.3", "Bun v1.4.3"),
        ] }] } },
      ] })}`,
      'data: {"type":"message_stream_complete","conversation_id":"conv_cite"}',
      "data: [DONE]",
      "",
    ].join("\n\n");
    const citing = (citations?: string): JobRecord => ({ ...job(), options: { ...job().options, ...(citations ? { citations } : {}) } });

    test("numbered: become [n] references and a Sources list; counts only are logged", async () => {
      await withTokenFile(async (sessionTokenPath) => {
        const diagnosticsDir = await mkdtemp(join(tmpdir(), "pro-citations-"));
        try {
          const pageEvaluator = (async <T>(): Promise<T> => ({ ok: true, status: 200, body }) as T);

          const result = await runChatGptJob(citing("numbered"), { sessionTokenPath, pageEvaluator, diagnosticsDir });

          expect(result).toBe([
            "Bun 1.4.3 is out. [1][2]",
            "It checks types. [3]",
            "Also fast. [3]",
            "Notes: [Release notes](https://bun.com/blog/bun-v1.4.3)",
            "Unknown: end.",
            "",
            "Sources:",
            "[1] Releases — https://github.com/oven-sh/bun/releases",
            "[2] Blog — https://bun.com/blog",
            "[3] Bun v1.4.3 — https://bun.com/blog/bun-v1.4.3",
            "",
          ].join("\n"));
          const log = await readFile(join(diagnosticsDir, "citations.jsonl"), "utf8");
          expect(JSON.parse(log)).toMatchObject({
            jobId: "job_test",
            mode: "numbered",
            citations: 4,
            resolved: 3,
            links: 1,
            sources: 3,
            otherKinds: [],
            unresolvedRefTypes: { search: 1 },
            unresolvedInUnknownTurns: 1,
            unresolvedWithEntry: 0,
            indexedRefTypes: { search: 2, view: 2 },
          });
          expect(log).not.toContain("bun.com");
          expect(log).not.toContain("Releases");
        } finally {
          await rm(diagnosticsDir, { recursive: true, force: true });
        }
      });
    });

    test("strip: are removed and links kept; raw and an unset option leave the text alone", async () => {
      await withTokenFile(async (sessionTokenPath) => {
        const pageEvaluator = (async <T>(): Promise<T> => ({ ok: true, status: 200, body }) as T);

        expect(await runChatGptJob(citing("strip"), { sessionTokenPath, pageEvaluator })).toBe([
          "Bun 1.4.3 is out.",
          "It checks types.",
          "Also fast.",
          "Notes: [Release notes](https://bun.com/blog/bun-v1.4.3)",
          "Unknown: end.",
        ].join("\n"));
        expect(await runChatGptJob(citing("raw"), { sessionTokenPath, pageEvaluator })).toBe(answer);
        expect(await runChatGptJob(citing(), { sessionTokenPath, pageEvaluator })).toBe(answer);
      });
    });
  });

  test("writes no citation log for an answer without citations", async () => {
    await withTokenFile(async (sessionTokenPath) => {
      const diagnosticsDir = await mkdtemp(join(tmpdir(), "pro-citations-"));
      try {
        const pageEvaluator = (async <T>(): Promise<T> => ({ ok: true, status: 200, body: conversationStream("OK") }) as T);
        expect(await runChatGptJob(job(), { sessionTokenPath, pageEvaluator, diagnosticsDir })).toBe("OK");
        expect(await readFile(join(diagnosticsDir, "citations.jsonl"), "utf8").catch(() => null)).toBeNull();
      } finally {
        await rm(diagnosticsDir, { recursive: true, force: true });
      }
    });
  });

  test("continues appending across typed events between delta frames", async () => {
    await withTokenFile(async (sessionTokenPath) => {
      const pageEvaluator = (async <T>(): Promise<T> =>
        ({
          ok: true,
          status: 200,
          body: [
            'data: {"v":{"message":{"author":{"role":"assistant"},"content":{"content_type":"text","parts":[""]},"status":"in_progress"}}}',
            'data: {"p":"/message/content/parts/0","o":"append","v":"OK"}',
            'data: {"type":"metadata","v":{"ignored":true}}',
            'data: {"v":"OK"}',
            'data: {"type":"message_stream_complete"}',
            "",
          ].join("\n\n"),
        }) as T);

      const result = await runChatGptJob(job(), { sessionTokenPath, pageEvaluator });

      expect(result).toBe("OKOK");
    });
  });

  test("reads the whole answer of a saved chat that gets its title mid-answer", async () => {
    await withTokenFile(async (sessionTokenPath) => {
      const pageEvaluator = (async <T>(): Promise<T> =>
        ({
          ok: true,
          status: 200,
          body: [
            'event: delta_encoding\ndata: "v1"',
            'event: delta\ndata: {"p":"","o":"add","v":{"message":{"author":{"role":"assistant"},"channel":"final","recipient":"all","content":{"content_type":"text","parts":[""]},"status":"in_progress"},"conversation_id":"conv_titled"},"c":7}',
            'data: {"type":"message_marker","conversation_id":"conv_titled","message_id":"m1","marker":"user_visible_token","event":"first"}',
            'event: delta\ndata: {"p":"","o":"patch","v":[{"p":"/message/content/parts/0","o":"append","v":"First"},{"p":"/message/metadata/open_thread_summary","o":"add","v":{}}]}',
            'event: delta\ndata: {"p":"/message/content/parts/0","o":"append","v":" part"}',
            'event: delta\ndata: {"v":","}',
            'data: {"type":"title_generation","title":"A title","conversation_id":"conv_titled"}',
            'event: delta\ndata: {"v":" then"}',
            ": ping",
            'data: {"type":"url_moderation","url_moderation_result":{}}',
            'event: delta\ndata: {"v":" the rest."}',
            'event: delta\ndata: {"p":"","o":"patch","v":[{"p":"/message/status","o":"replace","v":"finished_successfully"},{"p":"/message/end_turn","o":"replace","v":true}]}',
            'data: {"type":"message_stream_complete","conversation_id":"conv_titled"}',
            "data: [DONE]",
            "",
          ].join("\n\n"),
        }) as T);

      const result = await runChatGptJob(job(), { sessionTokenPath, pageEvaluator });

      expect(result).toBe("First part, then the rest.");
    });
  });

  test("leaves out a progress note's text that follows a finished message added mid-note", async () => {
    await withTokenFile(async (sessionTokenPath) => {
      const pageEvaluator = (async <T>(): Promise<T> =>
        ({
          ok: true,
          status: 200,
          body: [
            'event: delta_encoding\ndata: "v1"',
            'event: delta\ndata: {"p":"","o":"add","v":{"message":{"author":{"role":"assistant"},"channel":"commentary","recipient":"all","content":{"content_type":"text","parts":["I am"]},"status":"in_progress"},"conversation_id":"conv_note"},"c":5}',
            'event: delta\ndata: {"p":"/message/content/parts/0","o":"append","v":" checking"}',
            'event: delta\ndata: {"p":"","o":"add","v":{"message":{"author":{"role":"assistant"},"channel":"commentary","recipient":"SubAgentActivityThreadItem.completed","content":{"content_type":"text","parts":[""]},"status":"finished_successfully"},"conversation_id":"conv_note"},"c":6}',
            'event: delta\ndata: {"p":"/message/content/parts/0","o":"append","v":" the"}',
            'event: delta\ndata: {"v":" files."}',
            'event: delta\ndata: {"p":"/message/status","o":"replace","v":"finished_successfully"}',
            'event: delta\ndata: {"p":"","o":"add","v":{"message":{"author":{"role":"assistant"},"channel":"final","recipient":"all","content":{"content_type":"text","parts":[""]},"status":"in_progress"},"conversation_id":"conv_note"},"c":7}',
            'event: delta\ndata: {"p":"","o":"patch","v":[{"p":"/message/content/parts/0","o":"append","v":"The"},{"p":"/message/metadata/open_thread_summary","o":"add","v":{}}]}',
            'event: delta\ndata: {"p":"/message/content/parts/0","o":"append","v":" answer"}',
            'event: delta\ndata: {"p":"","o":"add","v":{"message":{"author":{"role":"assistant"},"channel":"commentary","recipient":"SubAgentActivityThreadItem.completed","content":{"content_type":"text","parts":[""]},"status":"finished_successfully"},"conversation_id":"conv_note"},"c":8}',
            'event: delta\ndata: {"p":"/message/content/parts/0","o":"append","v":" ends here."}',
            'event: delta\ndata: {"p":"","o":"patch","v":[{"p":"/message/status","o":"replace","v":"finished_successfully"},{"p":"/message/end_turn","o":"replace","v":true}]}',
            'data: {"type":"message_stream_complete","conversation_id":"conv_note"}',
            "data: [DONE]",
            "",
          ].join("\n\n"),
        }) as T);

      const result = await runChatGptJob(job(), { sessionTokenPath, pageEvaluator });

      expect(result).toBe("The answer ends here.");
    });
  });

  test("does not take text sent to another recipient as the answer", async () => {
    await withTokenFile(async (sessionTokenPath) => {
      const pageEvaluator = (async <T>(): Promise<T> =>
        ({
          ok: true,
          status: 200,
          body: [
            'data: {"message":{"author":{"role":"assistant"},"channel":"final","recipient":"all","content":{"content_type":"text","parts":["The answer."]},"status":"finished_successfully","end_turn":true},"conversation_id":"conv_recipient"}',
            'data: {"message":{"author":{"role":"assistant"},"channel":"commentary","recipient":"SubAgentActivityThreadItem.completed","content":{"content_type":"text","parts":["Sub-agent done."]},"status":"finished_successfully"},"conversation_id":"conv_recipient"}',
            "data: [DONE]",
            "",
          ].join("\n\n"),
        }) as T);

      const result = await runChatGptJob(job(), { sessionTokenPath, pageEvaluator });

      expect(result).toBe("The answer.");
    });
  });

  test("maps non-OK upstream responses to structured errors", async () => {
    await withTokenFile(async (sessionTokenPath) => {
      const pageEvaluator = (async <T>(): Promise<T> =>
        ({ ok: false, status: 429, body: "<html>limit</html>" }) as T);

      await expect(runChatGptJob(job(), { sessionTokenPath, pageEvaluator })).rejects.toThrow(ProError);
    });
  });

  test("a 403 for unusual activity gets its own code and is not retried; other 403s stay UPSTREAM_REJECTED", async () => {
    await withTokenFile(async (sessionTokenPath) => {
      let calls = 0;
      const refusal = (body: string) => (async <T>(): Promise<T> => {
        calls += 1;
        return { ok: false, status: 403, body } as T;
      }) as PageEvaluator;
      const codeOf = (promise: Promise<unknown>) => promise.then(() => null, (error: ProError) => error.code);

      const unusual = refusal('{"detail":"Unusual activity has been detected from your device. Try again later. (8d1e)"}');
      expect(await codeOf(runChatGptJob(job(), { sessionTokenPath, pageEvaluator: unusual, retries: 2, retryDelayMs: 0 }))).toBe("CHATGPT_UNUSUAL_ACTIVITY");
      expect(calls).toBe(1);
      const other = refusal('{"detail":"Forbidden"}');
      expect(await codeOf(runChatGptJob(job(), { sessionTokenPath, pageEvaluator: other }))).toBe("UPSTREAM_REJECTED");
    });
  });

  test("fails early when the CDP ChatGPT page is logged out", async () => {
    await withTokenFile(async (sessionTokenPath) => {
      const pageEvaluator = (async <T>(): Promise<T> =>
        ({
          ok: false,
          status: 200,
          body: "ChatGPT page session did not include an access token.",
          code: "CHATGPT_PAGE_LOGGED_OUT",
        }) as T);

      await expect(runChatGptJob(job(), { sessionTokenPath, pageEvaluator })).rejects.toThrow(
        "The ChatGPT CDP page is not logged in.",
      );
    });
  });

  test("HTTP 431 from the auth probe surfaces as CHATGPT_PROBE_FAILED with cookie-bloat guidance", async () => {
    // Regression guard: before the probe_failed split this fired as
    // logged_out, which sent agents down the wrong remediation path. The
    // 431-specific message must mention cookie buildup, not "sign in again".
    await withTokenFile(async (sessionTokenPath) => {
      const pageEvaluator = (async <T>(): Promise<T> =>
        ({
          ok: false,
          status: 431,
          body: "ChatGPT auth session probe returned HTTP 431.",
          code: "CHATGPT_PROBE_FAILED",
        }) as T);

      try {
        await runChatGptJob(job(), { sessionTokenPath, pageEvaluator });
        throw new Error("Expected CHATGPT_PROBE_FAILED.");
      } catch (error) {
        expect(error).toBeInstanceOf(ProError);
        const proError = error as ProError;
        expect(proError.code).toBe("CHATGPT_PROBE_FAILED");
        expect(proError.message).toContain("HTTP 431");
        expect(proError.suggestions.some((s) => s.toLowerCase().includes("cookie"))).toBe(true);
        expect(proError.suggestions.some((s) => s.includes("auth capture"))).toBe(true);
        expect(proError.details?.status).toBe(431);
      }
    });
  });

  test("non-431 probe failures still distinguish probe_failed from logged_out", async () => {
    await withTokenFile(async (sessionTokenPath) => {
      const pageEvaluator = (async <T>(): Promise<T> =>
        ({
          ok: false,
          status: 502,
          body: "ChatGPT auth session probe returned HTTP 502.",
          code: "CHATGPT_PROBE_FAILED",
        }) as T);

      try {
        await runChatGptJob(job(), { sessionTokenPath, pageEvaluator });
        throw new Error("Expected CHATGPT_PROBE_FAILED.");
      } catch (error) {
        const proError = error as ProError;
        expect(proError.code).toBe("CHATGPT_PROBE_FAILED");
        expect(proError.suggestions.some((s) => s.includes("Reload the CDP ChatGPT tab"))).toBe(true);
        // 502 is NOT 431; do not inappropriately suggest cookie remediation.
        expect(proError.suggestions.some((s) => s.toLowerCase().includes("cookie"))).toBe(false);
      }
    });
  });

  test("the in-page auth probe pins referrerPolicy to no-referrer", async () => {
    // The 431 saga we shipped traced back to the in-page fetch inheriting
    // the page's full URL as Referer. If a refactor drops the explicit
    // referrerPolicy, oversize tracking URLs will inflate headers again.
    await withTokenFile(async (sessionTokenPath) => {
      let captured = "";
      const pageEvaluator = (async <T>(_base: string, expression: string): Promise<T> => {
        captured = expression;
        return { ok: true, status: 200, body: conversationStream("OK") } as T;
      });

      await runChatGptJob(job(), { sessionTokenPath, pageEvaluator });
      expect(captured).toContain('referrerPolicy: "no-referrer"');
      // And the auth-session URL is also present (we expect both together).
      expect(captured).toContain("https://chatgpt.com/api/auth/session");
    });
  });

  test("retries on common transient 5xx upstream codes", async () => {
    // Lock down which codes get retried. A regression that narrows isRetryable
    // (e.g. only 503) would silently ship; verify 500/502/504 are also
    // retryable until we explicitly decide otherwise.
    for (const transientStatus of [500, 502, 504]) {
      await withTokenFile(async (sessionTokenPath) => {
        let attempts = 0;
        const pageEvaluator = (async <T>(): Promise<T> => {
          attempts += 1;
          if (attempts === 1) return { ok: false, status: transientStatus, body: "busy" } as T;
          return { ok: true, status: 200, body: conversationStream("OK") } as T;
        });
        const result = await runChatGptJob(job(), {
          sessionTokenPath,
          pageEvaluator,
          retries: 1,
          retryDelayMs: 0,
        });
        expect(result).toBe("OK");
        expect(attempts).toBe(2);
      });
    }
  });

  test("does NOT retry on 4xx authorization failures (would burn quota or amplify rate limits)", async () => {
    // 401 / 403 from the upstream conversation endpoint indicate auth has
    // gone bad; retrying just hammers the API. Verify the first attempt
    // throws and we did not silently retry.
    for (const fatalStatus of [401, 403]) {
      await withTokenFile(async (sessionTokenPath) => {
        let attempts = 0;
        const pageEvaluator = (async <T>(): Promise<T> => {
          attempts += 1;
          return { ok: false, status: fatalStatus, body: "<html>denied</html>" } as T;
        });
        await expect(
          runChatGptJob(job(), {
            sessionTokenPath,
            pageEvaluator,
            retries: 3,
            retryDelayMs: 0,
          }),
        ).rejects.toThrow(ProError);
        expect(attempts).toBe(1);
      });
    }
  });

  test("CHATGPT_PAGE_LOGGED_OUT and CHATGPT_PROBE_FAILED are NOT retried (terminal auth states)", async () => {
    for (const code of ["CHATGPT_PAGE_LOGGED_OUT", "CHATGPT_PROBE_FAILED"] as const) {
      await withTokenFile(async (sessionTokenPath) => {
        let attempts = 0;
        const pageEvaluator = (async <T>(): Promise<T> => {
          attempts += 1;
          return { ok: false, status: 431, body: "x", code } as T;
        });
        await expect(
          runChatGptJob(job(), { sessionTokenPath, pageEvaluator, retries: 3, retryDelayMs: 0 }),
        ).rejects.toThrow();
        expect(attempts).toBe(1);
      });
    }
  });

  test("missing session token throws SESSION_TOKEN_MISSING with auth exit code", async () => {
    try {
      await runChatGptJob(job(), { sessionTokenPath: join(tmpdir(), "pro-cli-test-no-such-token.json"), pageEvaluator: pageMustNotBeRead });
      throw new Error("Expected SESSION_TOKEN_MISSING.");
    } catch (error) {
      expect(error).toBeInstanceOf(ProError);
      const proError = error as ProError;
      expect(proError.code).toBe("SESSION_TOKEN_MISSING");
      expect(proError.suggestions[0]).toContain("auth capture");
    }
  });

  test("expired session token throws SESSION_TOKEN_EXPIRED", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pro-token-expired-"));
    const path = join(dir, "token.json");
    try {
      const expired = {
        version: 1,
        generatedAt: new Date().toISOString(),
        source: "pro-cli-cdp-page",
        accessToken: fakeJwt(),
        accountId: "acct_test",
        // Expired 1 hour ago.
        expiresAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      };
      await writeFile(path, JSON.stringify(expired));
      const asked: string[] = [];
      const loggedOutPage = (async <T>(_base: string, script: string): Promise<T> => {
        asked.push(script);
        return { status: 401, hasAccessToken: false } as T;
      });
      try {
        await runChatGptJob(job(), { sessionTokenPath: path, pageEvaluator: loggedOutPage });
        throw new Error("Expected SESSION_TOKEN_EXPIRED.");
      } catch (error) {
        expect(error).toBeInstanceOf(ProError);
        expect((error as ProError).code).toBe("SESSION_TOKEN_EXPIRED");
      }
      expect(asked).toEqual([PAGE_SESSION_TOKEN_EXPRESSION]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("missing accountId on the token throws ACCOUNT_ID_MISSING", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pro-token-no-account-"));
    const path = join(dir, "token.json");
    try {
      // JWT with no chatgpt_account_id claim.
      const noAccountJwt = [
        "header",
        Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url"),
        "sig",
      ].join(".");
      await writeFile(
        path,
        JSON.stringify({
          version: 1,
          generatedAt: new Date().toISOString(),
          source: "pro-cli-cdp-page",
          accessToken: noAccountJwt,
          // accountId intentionally omitted
          expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        }),
      );
      try {
        await runChatGptJob(job(), { sessionTokenPath: path, pageEvaluator: pageMustNotBeRead });
        throw new Error("Expected ACCOUNT_ID_MISSING.");
      } catch (error) {
        expect(error).toBeInstanceOf(ProError);
        expect((error as ProError).code).toBe("ACCOUNT_ID_MISSING");
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("ChatGPT transport: stored session token refresh", () => {
  // A stored token with minutesLeft to live, and a page whose own token lasts pageMinutes.
  async function withExpiringToken(
    minutesLeft: number,
    page: { minutes: number; account?: string } | null,
    fn: (path: string, run: () => Promise<string>, requests: string[]) => Promise<void>,
  ) {
    const dir = await mkdtemp(join(tmpdir(), "pro-token-refresh-"));
    const path = join(dir, "token.json");
    const expiresAt = new Date(Date.now() + minutesLeft * 60_000);
    await writeFile(path, JSON.stringify({
      version: 1,
      generatedAt: new Date().toISOString(),
      source: "pro-cli-cdp-page",
      accessToken: jwtFor("acct_test", expiresAt),
      accountId: "acct_test",
      expiresAt: expiresAt.toISOString(),
    }));
    const requests: string[] = [];
    const pageEvaluator = (async <T>(_base: string, script: string): Promise<T> => {
      if (script === PAGE_SESSION_TOKEN_EXPRESSION) {
        if (!page) return { status: 401, hasAccessToken: false } as T;
        const accessToken = jwtFor(page.account ?? "acct_test", new Date(Date.now() + page.minutes * 60_000));
        return { status: 200, hasAccessToken: true, accessToken } as T;
      }
      requests.push(script);
      return { ok: true, status: 200, body: conversationStream("OK") } as T;
    });
    try {
      await fn(path, () => runChatGptJob(job(), { sessionTokenPath: path, pageEvaluator }), requests);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  test("an expired stored token is replaced by the page's longer-lived token for the same account", async () => {
    await withExpiringToken(-60, { minutes: 7 * 24 * 60 }, async (path, run, requests) => {
      expect(await run()).toBe("OK");
      expect(requests).toHaveLength(1);
      const saved = JSON.parse(await readFile(path, "utf8"));
      expect(saved.accountId).toBe("acct_test");
      expect(Date.parse(saved.expiresAt)).toBeGreaterThan(Date.now() + 6 * 24 * 60 * 60_000);
    });
  });

  test("a stored token close to expiry is refreshed, and a fresh one leaves the page alone", async () => {
    await withExpiringToken(10, { minutes: 7 * 24 * 60 }, async (path, run) => {
      await run();
      expect(Date.parse(JSON.parse(await readFile(path, "utf8")).expiresAt)).toBeGreaterThan(Date.now() + 24 * 60 * 60_000);
    });
    await withExpiringToken(120, { minutes: 7 * 24 * 60 }, async (path, run) => {
      const before = await readFile(path, "utf8");
      await run();
      expect(await readFile(path, "utf8")).toBe(before);
    });
  });

  test("the page's token is not taken for another account, or when the page is logged out", async () => {
    for (const page of [{ minutes: 7 * 24 * 60, account: "acct_other" }, null]) {
      await withExpiringToken(-60, page, async (path, run, requests) => {
        const before = await readFile(path, "utf8");
        await expect(run()).rejects.toMatchObject({ code: "SESSION_TOKEN_EXPIRED" });
        expect(requests).toEqual([]);
        expect(await readFile(path, "utf8")).toBe(before);
      });
    }
  });
});

describe("ChatGPT transport: model usage limits", () => {
  const resetsAfter = new Date(Date.now() + 3 * 24 * 60 * 60_000).toISOString();
  const reduced = "Capabilities reduced until November 3. Responses may have lower quality.";
  // A conversation/init answer for an account whose limit on `model` resets at `resets`.
  const initBody = (model: string, resets = resetsAfter) => JSON.stringify({
    type: "conversation_detail_metadata",
    banner_info: { name: model, resets_after: resets, description: reduced },
    blocked_features: [{ name: "reason", resets_after: resets, limit: 200, description: reduced }],
    model_limits: [{ model_slug: model, using_default_model_slug: model, resets_after: resets, description: null }],
    limits_progress: [],
    default_model_slug: "gpt-5-5-thinking",
  });

  test("the page script checks a chat model's limit before it sends anything", async () => {
    await withTokenFile(async (sessionTokenPath) => {
      let expression = "";
      const pageEvaluator = (async <T>(_base: string, script: string): Promise<T> => {
        expression = script;
        return { ok: true, status: 200, body: conversationStream("OK") } as T;
      });

      expect(await runChatGptJob(job(), { sessionTokenPath, pageEvaluator })).toBe("OK");
      expect(expression).toContain("async function pageModelLimitBody");
      expect(expression.indexOf("modelLimitBody(requestBody.model")).toBeLessThan(expression.indexOf("/f/conversation/prepare\", {"));
    });
  });

  test("a job on a model whose usage limit is reached fails with the limit's reset time", async () => {
    await withTokenFile(async (sessionTokenPath) => {
      let evaluations = 0;
      const pageEvaluator = (async <T>(): Promise<T> => {
        evaluations += 1;
        return { ok: false, status: 200, code: "CHATGPT_MODEL_LIMITED", body: initBody("gpt-5-5-pro") } as T;
      });

      const error = await runChatGptJob(job(), { sessionTokenPath, pageEvaluator, retries: 2 }).catch((caught) => caught);

      expect(error).toBeInstanceOf(ProError);
      expect(error.toPayload()).toMatchObject({
        code: "UPSTREAM_ERROR",
        details: { errorCode: "usage_limit", model: "gpt-5-5-pro", resetsAfter, limitDescription: reduced },
      });
      expect(error.message).toBe(`ChatGPT's usage limit for gpt-5-5-pro is reached until ${resetsAfter}; nothing was sent.`);
      expect(evaluations).toBe(1);
    });
  });

  test("a limited model is still refused when the limit's details cannot be read", async () => {
    await withTokenFile(async (sessionTokenPath) => {
      const pageEvaluator = (async <T>(): Promise<T> =>
        ({ ok: false, status: 200, code: "CHATGPT_MODEL_LIMITED", body: "<html>" }) as T);

      const error = await runChatGptJob(job(), { sessionTokenPath, pageEvaluator }).catch((caught) => caught);

      expect(error.toPayload()).toMatchObject({ code: "UPSTREAM_ERROR", details: { errorCode: "usage_limit", model: "gpt-5-5-pro" } });
      expect(error.details).not.toHaveProperty("resetsAfter");
    });
  });
});

describe("ChatGPT transport: cut-off answer streams", () => {
  test("polls the conversation for the answer when the stream ends before the answer", async () => {
    await withTokenFile(async (sessionTokenPath) => {
      const diagnosticsDir = await mkdtemp(join(tmpdir(), "pro-stream-diag-"));
      try {
        const answerFetches: string[] = [];
        const pageEvaluator = (async <T>(_base: string, script: string): Promise<T> => {
          if (script.includes("fetchConversationAnswer")) {
            answerFetches.push(script);
            return (answerFetches.length === 1
              ? { ok: true, status: 200, state: "pending", text: null, message: "assistant thoughts in_progress" }
              : { ok: true, status: 200, state: "done", text: "Recovered answer", message: "assistant text finished_successfully end_turn" }) as T;
          }
          return { ok: true, status: 200, body: cutOffStream("conv_cut") } as T;
        });

        const result = await runChatGptJob(job(), {
          sessionTokenPath,
          pageEvaluator,
          diagnosticsDir,
          streamRecoveryPollMs: 0,
        });

        expect(result).toBe("Recovered answer");
        expect(answerFetches).toHaveLength(2);
        expect(answerFetches[0]).toContain('"conv_cut"');
        const diagnostics = await readFile(join(diagnosticsDir, "job_test-stream.json"), "utf8");
        expect(JSON.parse(diagnostics)).toMatchObject({
          jobId: "job_test",
          code: "STREAM_INCOMPLETE",
          conversationId: "conv_cut",
          sawDone: false,
          sawStreamComplete: false,
        });
        expect(diagnostics).toContain("msg user text finished_successfully");
        expect(diagnostics).not.toContain("secret question text");
        expect(diagnostics).not.toContain("resume-token-value");
      } finally {
        await rm(diagnosticsDir, { recursive: true, force: true });
      }
    });
  });

  test("records the server's routing flags and handoff options of a cut-off stream, without ids", async () => {
    await withTokenFile(async (sessionTokenPath) => {
      const diagnosticsDir = await mkdtemp(join(tmpdir(), "pro-stream-diag-"));
      try {
        const pageEvaluator = (async <T>(_base: string, script: string): Promise<T> => {
          if (script.includes("fetchConversationAnswer")) {
            return { ok: true, status: 200, state: "done", text: "Recovered answer", message: null } as T;
          }
          return {
            ok: true,
            status: 200,
            body: cutOffStream("conv_flags", [
              'data: {"type":"stream_handoff","conversation_id":"conv_flags","turn_exchange_id":"tx-1","options":[{"type":"resume_sse_endpoint"},{"type":"subscribe_ws_topic","topic_id":"conv-turn-low-ttl-topic-id-value"}]}',
              'data: {"type":"conversation_async_status","conversation_id":"conv_flags","async_status":2}',
              'data: {"type":"server_ste_metadata","conversation_id":"conv_flags","metadata":{"turn_mode":"pro","pro_mode_turn_topic_streaming":true,"resume_with_websockets":false,"low_turn_topic_ttl":600,"request_id":"request-id-value","user_agent":"user-agent-value","search_tool_query_types":["query-type-value"]}}',
            ]),
          } as T;
        });

        await runChatGptJob(job(), { sessionTokenPath, pageEvaluator, diagnosticsDir, streamRecoveryPollMs: 0 });

        const diagnostics = await readFile(join(diagnosticsDir, "job_test-stream.json"), "utf8");
        const record = JSON.parse(diagnostics);
        expect(record.serverSteMetadata).toEqual([
          { turn_mode: "pro", pro_mode_turn_topic_streaming: true, resume_with_websockets: false, low_turn_topic_ttl: 600 },
        ]);
        expect(record.events).toContain("stream_handoff options=resume_sse_endpoint,subscribe_ws_topic(conv-turn-low-ttl-)");
        expect(record.events).toContain("conversation_async_status async_status=2");
        for (const value of ["topic-id-value", "request-id-value", "user-agent-value", "query-type-value", "tx-1"]) {
          expect(diagnostics).not.toContain(value);
        }
      } finally {
        await rm(diagnosticsDir, { recursive: true, force: true });
      }
    });
  });

  test("does not accept partial answer text from a stream that was cut off", async () => {
    await withTokenFile(async (sessionTokenPath) => {
      const pageEvaluator = (async <T>(_base: string, script: string): Promise<T> => {
        if (script.includes("fetchConversationAnswer")) {
          return { ok: true, status: 200, state: "done", text: "Partial answer, then the rest.", message: null } as T;
        }
        return {
          ok: true,
          status: 200,
          body: cutOffStream("conv_partial", [
            'data: {"p":"/message/content/parts/0","o":"append","v":"Partial answer"}',
          ]),
        } as T;
      });

      const result = await runChatGptJob(job(), { sessionTokenPath, pageEvaluator, streamRecoveryPollMs: 0 });

      expect(result).toBe("Partial answer, then the rest.");
    });
  });

  test("does not take the first response's [DONE] as the end of a handed-off stream that was cut off", async () => {
    const segments = (rest: string[]) => [
      'event: delta_encoding\ndata: "v1"',
      'data: {"type":"resume_conversation_token","token":"t","conversation_id":"conv_handoff"}',
      'data: {"type":"stream_handoff","conversation_id":"conv_handoff"}',
      "data: [DONE]",
      'event: delta_encoding\ndata: "v1"',
      'event: delta\ndata: {"p":"","o":"add","v":{"message":{"author":{"role":"assistant"},"channel":"final","recipient":"all","content":{"content_type":"text","parts":[""]},"status":"in_progress"},"conversation_id":"conv_handoff"},"c":3}',
      'event: delta\ndata: {"p":"/message/content/parts/0","o":"append","v":"Partial"}',
      ...rest,
      "",
    ].join("\n\n");
    await withTokenFile(async (sessionTokenPath) => {
      let answerFetches = 0;
      const answerFor = (body: string) => (async <T>(_base: string, script: string): Promise<T> => {
        if (script.includes("fetchConversationAnswer")) {
          answerFetches += 1;
          return { ok: true, status: 200, state: "done", text: "Partial answer, finished.", message: null } as T;
        }
        return { ok: true, status: 200, body } as T;
      });

      expect(await runChatGptJob(job(), { sessionTokenPath, pageEvaluator: answerFor(segments([])), streamRecoveryPollMs: 0 }))
        .toBe("Partial answer, finished.");
      expect(answerFetches).toBe(1);

      const complete = segments([
        'event: delta\ndata: {"v":" answer."}',
        'event: delta\ndata: {"p":"","o":"patch","v":[{"p":"/message/status","o":"replace","v":"finished_successfully"},{"p":"/message/end_turn","o":"replace","v":true}]}',
        'data: {"type":"message_stream_complete","conversation_id":"conv_handoff"}',
        "data: [DONE]",
      ]);
      expect(await runChatGptJob(job(), { sessionTokenPath, pageEvaluator: answerFor(complete), streamRecoveryPollMs: 0 }))
        .toBe("Partial answer.");
      expect(answerFetches).toBe(1);
    });
  });

  test("keeps the stream error with diagnostics when the conversation cannot be fetched", async () => {
    await withTokenFile(async (sessionTokenPath) => {
      const diagnosticsDir = await mkdtemp(join(tmpdir(), "pro-stream-diag-"));
      try {
        let answerFetches = 0;
        const pageEvaluator = (async <T>(_base: string, script: string): Promise<T> => {
          if (script.includes("fetchConversationAnswer")) {
            answerFetches += 1;
            return { ok: false, status: 404, state: "pending", text: null, message: null } as T;
          }
          return { ok: true, status: 200, body: cutOffStream("conv_gone") } as T;
        });

        try {
          await runChatGptJob(job(), { sessionTokenPath, pageEvaluator, diagnosticsDir, streamRecoveryPollMs: 0 });
          throw new Error("Expected STREAM_INCOMPLETE.");
        } catch (error) {
          expect(error).toBeInstanceOf(ProError);
          const proError = error as ProError;
          expect(proError.code).toBe("STREAM_INCOMPLETE");
          expect(proError.details).toMatchObject({
            attempts: 1,
            conversationId: "conv_gone",
            stream: { sawDone: false, sawStreamComplete: false },
            recovery: { state: "unavailable", status: 404, polls: 3 },
            diagnosticsPath: join(diagnosticsDir, "job_test-stream.json"),
          });
        }
        expect(answerFetches).toBe(3);
      } finally {
        await rm(diagnosticsDir, { recursive: true, force: true });
      }
    });
  });

  test("does not return a Pro progress note as the answer when the stream ends early", async () => {
    await withTokenFile(async (sessionTokenPath) => {
      let answerFetches = 0;
      const pageEvaluator = (async <T>(_base: string, script: string): Promise<T> => {
        if (script.includes("fetchConversationAnswer")) {
          answerFetches += 1;
          return { ok: true, status: 200, state: "done", text: "The final answer.", message: "assistant text finished_successfully final end_turn" } as T;
        }
        return {
          ok: true,
          status: 200,
          body: [
            ...progressNoteFrames("conv_note", "I'm testing whether smoothing helps."),
            'data: {"type":"message_stream_complete","conversation_id":"conv_note"}',
            "data: [DONE]",
            "",
          ].join("\n\n"),
        } as T;
      });

      const result = await runChatGptJob(job(), { sessionTokenPath, pageEvaluator, streamRecoveryPollMs: 0 });

      expect(result).toBe("The final answer.");
      expect(answerFetches).toBe(1);
    });
  });

  test("returns only the final-channel answer after Pro progress notes", async () => {
    await withTokenFile(async (sessionTokenPath) => {
      const pageEvaluator = (async <T>(_base: string, script: string): Promise<T> => {
        if (script.includes("fetchConversationAnswer")) throw new Error("No recovery expected.");
        return {
          ok: true,
          status: 200,
          body: [
            ...progressNoteFrames("conv_final", "Checking the bound."),
            'data: {"p":"","o":"add","v":{"message":{"author":{"role":"assistant"},"channel":"final","recipient":"all","content":{"content_type":"text","parts":[""]},"status":"in_progress","end_turn":null},"conversation_id":"conv_final"},"c":4}',
            'data: {"p":"/message/content/parts/0","o":"append","v":"Final "}',
            'data: {"v":"answer."}',
            'data: {"p":"","o":"patch","v":[{"p":"/message/status","o":"replace","v":"finished_successfully"},{"p":"/message/end_turn","o":"replace","v":true}]}',
            'data: {"type":"message_stream_complete","conversation_id":"conv_final"}',
            "data: [DONE]",
            "",
          ].join("\n\n"),
        } as T;
      });

      const result = await runChatGptJob(job(), { sessionTokenPath, pageEvaluator });

      expect(result).toBe("Final answer.");
    });
  });

  test("recovery finds the final answer in the stored conversation, skipping progress notes", async () => {
    await withTokenFile(async (sessionTokenPath) => {
      const now = Date.now() / 1000;
      const stored = (withFinal: boolean) => ({
        current_node: withFinal ? "recap" : "note",
        mapping: {
          user: { message: { author: { role: "user" }, content: { content_type: "text", parts: ["q"] }, status: "finished_successfully", create_time: now } },
          old: { message: { author: { role: "assistant" }, channel: "final", recipient: "all", content: { content_type: "text", parts: ["Earlier turn."] }, status: "finished_successfully", end_turn: true, create_time: now - 3600 } },
          note: { message: { author: { role: "assistant" }, channel: "commentary", recipient: "all", content: { content_type: "text", parts: ["I'm checking."] }, status: "finished_successfully", end_turn: false, create_time: now + 1, metadata: { is_thinking_preamble_message: true } } },
          ...(withFinal
            ? {
                final: { message: { author: { role: "assistant" }, channel: "final", recipient: "all", content: { content_type: "text", parts: ["Stored ", "answer."] }, status: "finished_successfully", end_turn: true, create_time: now + 3 } },
                recap: { message: { author: { role: "assistant" }, recipient: "all", content: { content_type: "reasoning_recap", content: "Thought for 40m" }, status: "finished_successfully", end_turn: true, create_time: now + 2 } },
              }
            : {}),
        },
      });
      let fetches = 0;
      const realFetch = globalThis.fetch;
      const pageEvaluator = (async <T>(_base: string, script: string): Promise<T> => {
        if (!script.includes("fetchConversationAnswer")) return { ok: true, status: 200, body: cutOffStream("conv_stored") } as T;
        fetches += 1;
        const body = stored(fetches > 1);
        globalThis.fetch = (async (url: string | URL | Request) =>
          String(url).endsWith("/api/auth/session")
            ? Response.json({ accessToken: "tok" })
            : Response.json(body)) as typeof fetch;
        try {
          return (await (0, eval)(script)) as T;
        } finally {
          globalThis.fetch = realFetch;
        }
      });

      const result = await runChatGptJob(job(), { sessionTokenPath, pageEvaluator, streamRecoveryPollMs: 0 });

      expect(result).toBe("Stored answer.");
      expect(fetches).toBe(2);
    });
  });

  test("stops polling for the answer when the request timeout runs out", async () => {
    await withTokenFile(async (sessionTokenPath) => {
      let answerFetches = 0;
      const pageEvaluator = (async <T>(_base: string, script: string): Promise<T> => {
        if (script.includes("fetchConversationAnswer")) {
          answerFetches += 1;
          return { ok: true, status: 200, state: "pending", text: null, message: "assistant thoughts in_progress" } as T;
        }
        return { ok: true, status: 200, body: cutOffStream("conv_slow") } as T;
      });

      const started = Date.now();
      try {
        await runChatGptJob(job(), { sessionTokenPath, pageEvaluator, timeoutMs: 400, streamRecoveryPollMs: 50 });
        throw new Error("Expected STREAM_INCOMPLETE.");
      } catch (error) {
        expect((error as ProError).code).toBe("STREAM_INCOMPLETE");
        expect((error as ProError).details).toMatchObject({
          recovery: { state: "timeout", message: "assistant thoughts in_progress" },
        });
      }
      expect(answerFetches).toBeGreaterThan(1);
      expect(Date.now() - started).toBeLessThan(2_000);
    });
  });

  test("reports an empty stored answer as EMPTY_RESPONSE without waiting", async () => {
    await withTokenFile(async (sessionTokenPath) => {
      const pageEvaluator = (async <T>(_base: string, script: string): Promise<T> => {
        if (script.includes("fetchConversationAnswer")) {
          return { ok: true, status: 200, state: "empty", text: null, message: "assistant text finished_successfully end_turn" } as T;
        }
        return {
          ok: true,
          status: 200,
          body: [
            'data: {"conversation_id":"conv_empty","message":{"author":{"role":"assistant"},"content":{"content_type":"text","parts":[]},"status":"finished_successfully","end_turn":true}}',
            "data: [DONE]",
            "",
          ].join("\n\n"),
        } as T;
      });

      try {
        await runChatGptJob(job(), { sessionTokenPath, pageEvaluator, streamRecoveryPollMs: 0 });
        throw new Error("Expected EMPTY_RESPONSE.");
      } catch (error) {
        expect((error as ProError).code).toBe("EMPTY_RESPONSE");
        expect((error as ProError).details).toMatchObject({
          conversationId: "conv_empty",
          stream: { sawDone: true },
          recovery: { state: "empty", polls: 1 },
        });
      }
    });
  });

  test("stops reading the stream in the page before the CDP evaluation times out", async () => {
    await withTokenFile(async (sessionTokenPath) => {
      let expression = "";
      let evaluateTimeoutMs: number | undefined;
      const pageEvaluator = (async <T>(_base: string, script: string, timeoutMs?: number): Promise<T> => {
        expression = script;
        evaluateTimeoutMs = timeoutMs;
        return { ok: true, status: 200, body: conversationStream("OK") } as T;
      });

      await runChatGptJob(job(), { sessionTokenPath, pageEvaluator });
      expect(evaluateTimeoutMs).toBe(30 * 60_000);
      // After the stream budget comes the key the page publishes the chat id under, then the model-limit check.
      expect(expression).toMatch(/, "acct_test", 1680000, "[0-9a-f]{8}-[0-9a-f-]{27}", async function pageModelLimitBody\(/);

      await runChatGptJob(job(), { sessionTokenPath, pageEvaluator, timeoutMs: 60_000 });
      expect(evaluateTimeoutMs).toBe(60_000);
      expect(expression).toMatch(/, "acct_test", 48000, "[0-9a-f]{8}-[0-9a-f-]{27}", async function pageModelLimitBody\(/);
    });
  });
});

describe("deleteConversation and preamble", () => {
  function savedJob(options: Record<string, unknown>): JobRecord {
    const base = job();
    return { ...base, options: { ...base.options, temporary: false, ...options } };
  }

  const storedOk = { ok: true, status: 200, state: "done", text: "OK", message: null };

  // Routes conversation requests to `body`, stored-answer reads to `answer` (default: the
  // stored copy says "OK"; an array gives one answer per read, repeating the last),
  // records chat deletions, and keeps the order of the calls.
  function evaluator(body: string, opts: { answer?: unknown; patchOk?: boolean } = {}) {
    const patches: string[] = [];
    const order: string[] = [];
    let request = "";
    let reads = 0;
    const pageEvaluator = (async <T>(_base: string, script: string): Promise<T> => {
      if (script.includes("is_visible")) {
        order.push("delete");
        patches.push(script);
        return { ok: opts.patchOk ?? true, status: opts.patchOk === false ? 500 : 200 } as T;
      }
      if (script.includes("fetchConversationAnswer")) {
        order.push("stored");
        const answers = Array.isArray(opts.answer) ? opts.answer : [opts.answer ?? storedOk];
        reads += 1;
        return answers[Math.min(reads, answers.length) - 1] as T;
      }
      order.push("request");
      request = script;
      return { ok: true, status: 200, body } as T;
    });
    return { pageEvaluator, patches, order, request: () => request };
  }

  test("deletes the new saved chat after the answer arrives", async () => {
    await withTokenFile(async (sessionTokenPath) => {
      const fake = evaluator(savedConversationStream("conv_saved", "OK"));
      const result = await runChatGptJob(savedJob({ deleteConversation: true }), {
        sessionTokenPath,
        pageEvaluator: fake.pageEvaluator,
      });

      expect(result).toBe("OK");
      expect(fake.order).toEqual(["request", "stored", "delete"]);
      expect(requestBodyFromExpression(fake.request())).not.toHaveProperty("history_and_training_disabled");
      expect(fake.patches).toHaveLength(1);
      expect(fake.patches[0]).toContain("conv_saved");
      expect(fake.patches[0]).toContain('"is_visible":false');
    });
  });

  test("uses the stored answer when the streamed one is cut short, and records the mismatch", async () => {
    await withTokenFile(async (sessionTokenPath) => {
      const diagnosticsDir = await mkdtemp(join(tmpdir(), "pro-delete-diag-"));
      try {
        const fake = evaluator(savedConversationStream("conv_short", "The answer is cu"), {
          answer: { ok: true, status: 200, state: "done", text: "The answer is cut short no more.", message: null },
        });
        const result = await runChatGptJob(savedJob({ deleteConversation: true }), {
          sessionTokenPath,
          pageEvaluator: fake.pageEvaluator,
          diagnosticsDir,
        });

        expect(result).toBe("The answer is cut short no more.");
        expect(fake.order).toEqual(["request", "stored", "delete"]);
        const diagnostics = await readFile(join(diagnosticsDir, "job_test-stream.json"), "utf8");
        expect(JSON.parse(diagnostics)).toMatchObject({
          jobId: "job_test",
          code: "STREAM_ANSWER_MISMATCH",
          conversationId: "conv_short",
          streamedChars: 16,
          storedChars: 32,
          streamedIsPrefix: true,
          firstDifferenceAt: 16,
        });
        expect(diagnostics).not.toContain("The answer is");
        const deleted = await readFile(join(diagnosticsDir, "deleted-conversations.jsonl"), "utf8");
        expect(JSON.parse(deleted.trim())).toMatchObject({ jobId: "job_test", conversationId: "conv_short" });
      } finally {
        await rm(diagnosticsDir, { recursive: true, force: true });
      }
    });
  });

  test("keeps the streamed answer when the stored one cannot be read", async () => {
    await withTokenFile(async (sessionTokenPath) => {
      const fake = evaluator(savedConversationStream("conv_gone", "Streamed answer."), {
        answer: { ok: false, status: 404, state: "pending", text: null, message: null },
      });
      const result = await runChatGptJob(savedJob({ deleteConversation: true }), {
        sessionTokenPath,
        pageEvaluator: fake.pageEvaluator,
        streamRecoveryPollMs: 0,
      });

      expect(result).toBe("Streamed answer.");
      expect(fake.order).toEqual(["request", "stored", "stored", "stored", "delete"]);
    });
  });

  test("retries a rate-limited read of the stored answer instead of keeping a cut-off stream", async () => {
    await withTokenFile(async (sessionTokenPath) => {
      const limited = { ok: false, status: 429, state: "pending", text: null, message: null, retryAfterMs: null };
      const fake = evaluator(savedConversationStream("conv_busy", "The answer is cu"), {
        answer: [limited, { ...limited, status: 503 }, { ok: true, status: 200, state: "done", text: "The answer is cut short no more.", message: null }],
      });
      const result = await runChatGptJob(savedJob({ deleteConversation: true }), {
        sessionTokenPath,
        pageEvaluator: fake.pageEvaluator,
        streamRecoveryPollMs: 0,
      });

      expect(result).toBe("The answer is cut short no more.");
      expect(fake.order).toEqual(["request", "stored", "stored", "stored", "delete"]);
    });
  });

  test("waits as long as Retry-After asks before reading the stored answer again", async () => {
    await withTokenFile(async (sessionTokenPath) => {
      const fake = evaluator(savedConversationStream("conv_wait", "OK"), {
        answer: [{ ok: false, status: 429, state: "pending", text: null, message: null, retryAfterMs: 150 }, storedOk],
      });
      const started = Date.now();
      const result = await runChatGptJob(savedJob({ deleteConversation: true }), {
        sessionTokenPath,
        pageEvaluator: fake.pageEvaluator,
        streamRecoveryPollMs: 0,
      });

      expect(result).toBe("OK");
      expect(Date.now() - started).toBeGreaterThanOrEqual(140);
    });
  });

  test("records when the stored answer cannot be read", async () => {
    await withTokenFile(async (sessionTokenPath) => {
      const diagnosticsDir = await mkdtemp(join(tmpdir(), "pro-delete-diag-"));
      try {
        const fake = evaluator(savedConversationStream("conv_denied", "Streamed answer."), {
          answer: { ok: false, status: 403, state: "pending", text: null, message: null },
        });
        const result = await runChatGptJob(savedJob({ deleteConversation: true }), {
          sessionTokenPath,
          pageEvaluator: fake.pageEvaluator,
          diagnosticsDir,
          streamRecoveryPollMs: 0,
        });

        expect(result).toBe("Streamed answer.");
        const diagnostics = await readFile(join(diagnosticsDir, "job_test-stream.json"), "utf8");
        expect(JSON.parse(diagnostics)).toMatchObject({
          code: "STORED_ANSWER_UNAVAILABLE",
          conversationId: "conv_denied",
          streamedChars: 16,
          recovery: { state: "unavailable", status: 403, polls: 1 },
        });
        expect(diagnostics).not.toContain("Streamed answer");
      } finally {
        await rm(diagnosticsDir, { recursive: true, force: true });
      }
    });
  });

  test("keeps polling a cut-off stream's chat through rate limits and server errors", async () => {
    await withTokenFile(async (sessionTokenPath) => {
      const pending = { ok: true, status: 200, state: "pending", text: null, message: "assistant thoughts in_progress" };
      const fake = evaluator(cutOffStream("conv_long"), {
        answer: [
          pending,
          { ok: false, status: 429, state: "pending", text: null, message: null },
          { ok: false, status: 502, state: "pending", text: null, message: null },
          pending,
          { ok: false, status: 429, state: "pending", text: null, message: null },
          { ok: true, status: 200, state: "done", text: "Recovered answer", message: null },
        ],
      });
      const result = await runChatGptJob(savedJob({ deleteConversation: true }), {
        sessionTokenPath,
        pageEvaluator: fake.pageEvaluator,
        streamRecoveryPollMs: 0,
      });

      expect(result).toBe("Recovered answer");
      expect(fake.order.filter((call) => call === "stored")).toHaveLength(6);
      expect(fake.patches).toHaveLength(1);
    });
  });

  test("keeps the chat without deleteConversation or when continuing a chat", async () => {
    await withTokenFile(async (sessionTokenPath) => {
      for (const options of [{}, { deleteConversation: true, conversationId: "conv_old", parentMessageId: "msg_1" }]) {
        const fake = evaluator(savedConversationStream("conv_old", "OK"));
        expect(await runChatGptJob(savedJob(options), { sessionTokenPath, pageEvaluator: fake.pageEvaluator })).toBe("OK");
        expect(fake.patches).toHaveLength(0);
      }
    });
  });

  test("deletes the chat after recovering an answer from a cut-off stream", async () => {
    await withTokenFile(async (sessionTokenPath) => {
      const fake = evaluator(cutOffStream("conv_cut"), {
        answer: { ok: true, status: 200, state: "done", text: "Recovered answer", message: null },
      });
      const result = await runChatGptJob(savedJob({ deleteConversation: true }), {
        sessionTokenPath,
        pageEvaluator: fake.pageEvaluator,
        streamRecoveryPollMs: 0,
      });

      expect(result).toBe("Recovered answer");
      expect(fake.patches).toHaveLength(1);
      expect(fake.patches[0]).toContain("conv_cut");
    });
  });

  test("hands a failed job's chat over instead of deleting it", async () => {
    await withTokenFile(async (sessionTokenPath) => {
      const diagnosticsDir = await mkdtemp(join(tmpdir(), "pro-delete-diag-"));
      try {
        const kept: unknown[] = [];
        const fake = evaluator(cutOffStream("conv_failed"), {
          answer: { ok: true, status: 200, state: "empty", text: null, message: "assistant text finished_successfully" },
        });
        await expect(
          runChatGptJob(savedJob({ deleteConversation: true }), {
            sessionTokenPath,
            pageEvaluator: fake.pageEvaluator,
            diagnosticsDir,
            streamRecoveryPollMs: 0,
            onKeptConversation: (entry) => {
              kept.push(entry);
            },
          }),
        ).rejects.toBeInstanceOf(ProError);
        expect(kept).toEqual([{ conversationId: "conv_failed", reason: "failed" }]);
        expect(fake.patches).toHaveLength(0);
        const log = await readFile(join(diagnosticsDir, "kept-conversations.jsonl"), "utf8");
        expect(JSON.parse(log.trim())).toMatchObject({ jobId: "job_test", conversationId: "conv_failed", reason: "failed" });
      } finally {
        await rm(diagnosticsDir, { recursive: true, force: true });
      }
    });
  });

  test("hands the chat over when the stored answer cannot be read, and deletes it when that is checked", async () => {
    await withTokenFile(async (sessionTokenPath) => {
      const cases: Array<[unknown, unknown[]]> = [
        [{ ok: false, status: 403, state: "pending", text: null, message: null }, [{ conversationId: "conv_check", reason: "unverified" }]],
        [storedOk, []],
      ];
      for (const [answer, expected] of cases) {
        const kept: unknown[] = [];
        const fake = evaluator(savedConversationStream("conv_check", "OK"), { answer });
        const result = await runChatGptJob(savedJob({ deleteConversation: true }), {
          sessionTokenPath,
          pageEvaluator: fake.pageEvaluator,
          streamRecoveryPollMs: 0,
          onKeptConversation: (entry) => {
            kept.push(entry);
          },
        });
        expect(result).toBe("OK");
        expect(kept).toEqual(expected);
        expect(fake.patches).toHaveLength(expected.length === 0 ? 1 : 0);
      }
    });
  });

  test("deletes the chat when handing it over fails", async () => {
    await withTokenFile(async (sessionTokenPath) => {
      const fake = evaluator(savedConversationStream("conv_nohome", "OK"), {
        answer: { ok: false, status: 403, state: "pending", text: null, message: null },
      });
      const result = await runChatGptJob(savedJob({ deleteConversation: true }), {
        sessionTokenPath,
        pageEvaluator: fake.pageEvaluator,
        streamRecoveryPollMs: 0,
        onKeptConversation: () => {
          throw new Error("database is locked");
        },
      });
      expect(result).toBe("OK");
      expect(fake.patches).toHaveLength(1);
    });
  });

  test("gives up at once on a Retry-After longer than it may wait", async () => {
    await withTokenFile(async (sessionTokenPath) => {
      const fake = evaluator(savedConversationStream("conv_later", "OK"), {
        answer: [{ ok: false, status: 429, state: "pending", text: null, message: null, retryAfterMs: 20 * 60_000 }, storedOk],
      });
      const started = Date.now();
      const result = await runChatGptJob(savedJob({ deleteConversation: true }), {
        sessionTokenPath,
        pageEvaluator: fake.pageEvaluator,
        streamRecoveryPollMs: 0,
      });
      expect(result).toBe("OK");
      expect(Date.now() - started).toBeLessThan(1_000);
      expect(fake.order).toEqual(["request", "stored", "delete"]);
    });
  });

  test("a rate-limited read holds back the reads of other jobs until its Retry-After", async () => {
    await withTokenFile(async (sessionTokenPath) => {
      const reads: Array<{ conversation: string; at: number; status: number }> = [];
      const pageEvaluator = (async <T>(_base: string, script: string): Promise<T> => {
        if (script.includes("is_visible")) return { ok: true, status: 200 } as T;
        if (script.includes("fetchConversationAnswer")) {
          const conversation = script.includes('"conv_a"') ? "conv_a" : "conv_b";
          const limited = conversation === "conv_a" && !reads.some((read) => read.conversation === "conv_a");
          reads.push({ conversation, at: Date.now(), status: limited ? 429 : 200 });
          return (limited
            ? { ok: false, status: 429, state: "pending", text: null, message: null, retryAfterMs: 200 }
            : storedOk) as T;
        }
        if (script.includes("Second question")) {
          await Bun.sleep(50);
          return { ok: true, status: 200, body: savedConversationStream("conv_b", "OK") } as T;
        }
        return { ok: true, status: 200, body: savedConversationStream("conv_a", "OK") } as T;
      });
      const run = (jobRecord: JobRecord) =>
        runChatGptJob(jobRecord, { sessionTokenPath, pageEvaluator, streamRecoveryPollMs: 0 });

      const results = await Promise.all([
        run(savedJob({ deleteConversation: true })),
        run({ ...savedJob({ deleteConversation: true }), prompt: "Second question" }),
      ]);

      expect(results).toEqual(["OK", "OK"]);
      const limitedAt = reads.find((read) => read.status === 429)?.at ?? 0;
      const second = reads.filter((read) => read.conversation === "conv_b");
      expect(second).toHaveLength(1);
      expect(second[0].at - limitedAt).toBeGreaterThanOrEqual(180);
    });
  });

  test("slows its polls while a cut-off stream's answer stays pending", async () => {
    await withTokenFile(async (sessionTokenPath) => {
      const pending = { ok: true, status: 200, state: "pending", text: null, message: "assistant thoughts in_progress" };
      const reads: number[] = [];
      const pageEvaluator = (async <T>(_base: string, script: string): Promise<T> => {
        if (script.includes("fetchConversationAnswer")) {
          reads.push(Date.now());
          return (reads.length < 6 ? pending : { ok: true, status: 200, state: "done", text: "Recovered answer", message: null }) as T;
        }
        return { ok: true, status: 200, body: cutOffStream("conv_slow") } as T;
      });

      const result = await runChatGptJob(job(), { sessionTokenPath, pageEvaluator, streamRecoveryPollMs: 40 });

      expect(result).toBe("Recovered answer");
      // 40 ms growing 1.5x per poll: the fifth gap is at least 40 * 1.5^4 = 202 ms. Load only
      // lengthens gaps, so only lower bounds are checked, plus that the first gap is shorter.
      const gaps = reads.slice(1).map((at, index) => at - reads[index]);
      expect(gaps[0]).toBeGreaterThanOrEqual(39);
      expect(gaps[4]).toBeGreaterThanOrEqual(200);
      expect(gaps[0]).toBeLessThan(gaps[4]);
    });
  });

  test("fails at once with ChatGPT's error when it refuses the turn, and deletes the chat", async () => {
    await withTokenFile(async (sessionTokenPath) => {
      const diagnosticsDir = await mkdtemp(join(tmpdir(), "pro-delete-diag-"));
      try {
        const kept: unknown[] = [];
        const limits: unknown[] = [];
        const fake = evaluator([
          'event: delta_encoding\ndata: "v1"',
          'data: {"type":"resume_conversation_token","token":"t","conversation_id":"conv_refused"}',
          'data: {"type":"stream_handoff","conversation_id":"conv_refused"}',
          "data: [DONE]",
          'event: delta_encoding\ndata: "v1"',
          'event: delta\ndata: {"p":"","o":"add","v":{"message":{"author":{"role":"user"},"content":{"content_type":"text","parts":["secret question text"]},"status":"finished_successfully"},"conversation_id":"conv_refused"},"c":0}',
          'data: {"message":null,"conversation_id":"conv_refused","error":"You have reached the limit for this model.","error_code":"model_cap_exceeded"}',
          'data: {"type":"title_generation","title":"A title","conversation_id":"conv_refused"}',
          'data: {"type":"conversation_detail_metadata","limits_progress":[{"feature_name":"gpt_pro","remaining":0,"reset_after":"2026-10-19T03:00:00Z"}],"conversation_id":"conv_refused"}',
          "data: [DONE]",
          "",
        ].join("\n\n"));

        const error = await runChatGptJob(savedJob({ deleteConversation: true }), {
          sessionTokenPath,
          pageEvaluator: fake.pageEvaluator,
          diagnosticsDir,
          streamRecoveryPollMs: 0,
          onKeptConversation: (entry) => {
            kept.push(entry);
          },
          onLimits: (entries) => limits.push(...entries),
        }).catch((caught) => caught);

        expect(error).toBeInstanceOf(ProError);
        expect((error as ProError).code).toBe("UPSTREAM_ERROR");
        expect((error as ProError).message).toBe("You have reached the limit for this model.");
        expect((error as ProError).details).toMatchObject({ errorCode: "model_cap_exceeded" });
        expect(fake.order).toEqual(["request", "delete"]);
        expect(kept).toEqual([]);
        expect(limits).toEqual([{ feature_name: "gpt_pro", remaining: 0, reset_after: "2026-10-19T03:00:00Z" }]);
        const diagnostics = await readFile(join(diagnosticsDir, "job_test-stream.json"), "utf8");
        expect(JSON.parse(diagnostics)).toMatchObject({ code: "UPSTREAM_ERROR", conversationId: "conv_refused" });
        expect(diagnostics).toContain("error error_code=model_cap_exceeded");
        expect(diagnostics).toContain("limits gpt_pro=0@2026-10-19T03:00:00Z");
        expect(diagnostics).not.toContain("secret question text");
        expect(diagnostics).not.toContain("reached the limit");
      } finally {
        await rm(diagnosticsDir, { recursive: true, force: true });
      }
    });
  });

  test("names the usage counters in the summary of a cut-off stream", async () => {
    await withTokenFile(async (sessionTokenPath) => {
      const diagnosticsDir = await mkdtemp(join(tmpdir(), "pro-stream-diag-"));
      try {
        const pageEvaluator = (async <T>(_base: string, script: string): Promise<T> => {
          if (script.includes("fetchConversationAnswer")) return { ok: false, status: 403, state: "pending", text: null, message: null } as T;
          return { ok: true, status: 200, body: cutOffStream("conv_counted", [
            'data: {"type":"conversation_detail_metadata","limits_progress":[{"feature_name":"gpt_pro","remaining":3,"reset_after":"2026-10-19T03:00:00Z"}],"conversation_id":"conv_counted"}',
          ]) } as T;
        });

        await runChatGptJob(job(), { sessionTokenPath, pageEvaluator, diagnosticsDir, streamRecoveryPollMs: 0 }).catch(() => undefined);

        const diagnostics = await readFile(join(diagnosticsDir, "job_test-stream.json"), "utf8");
        expect(diagnostics).toContain("limits gpt_pro=3@2026-10-19T03:00:00Z");
      } finally {
        await rm(diagnosticsDir, { recursive: true, force: true });
      }
    });
  });

  test("deletes the chat when the job fails", async () => {
    await withTokenFile(async (sessionTokenPath) => {
      const fake = evaluator(cutOffStream("conv_empty"), {
        answer: { ok: true, status: 200, state: "empty", text: null, message: "assistant text finished_successfully" },
      });
      await expect(
        runChatGptJob(savedJob({ deleteConversation: true }), {
          sessionTokenPath,
          pageEvaluator: fake.pageEvaluator,
          streamRecoveryPollMs: 0,
        }),
      ).rejects.toBeInstanceOf(ProError);
      expect(fake.patches).toHaveLength(1);
      expect(fake.patches[0]).toContain("conv_empty");
    });
  });

  test("logs a chat it could not delete and still returns the answer", async () => {
    await withTokenFile(async (sessionTokenPath) => {
      const diagnosticsDir = await mkdtemp(join(tmpdir(), "pro-delete-diag-"));
      try {
        const fake = evaluator(savedConversationStream("conv_stuck", "OK"), { patchOk: false });
        const result = await runChatGptJob(savedJob({ deleteConversation: true }), {
          sessionTokenPath,
          pageEvaluator: fake.pageEvaluator,
          diagnosticsDir,
        });

        expect(result).toBe("OK");
        expect(fake.patches).toHaveLength(2);
        const log = await readFile(join(diagnosticsDir, "undeleted-conversations.jsonl"), "utf8");
        expect(JSON.parse(log.trim())).toMatchObject({ jobId: "job_test", conversationId: "conv_stuck" });
      } finally {
        await rm(diagnosticsDir, { recursive: true, force: true });
      }
    });
  });

  test("puts the preamble ahead of the instructions and the prompt", async () => {
    await withTokenFile(async (sessionTokenPath) => {
      const fake = evaluator(conversationStream("OK"));
      await runChatGptJob(savedJob({ preamble: "Keep the account owner private." }), {
        sessionTokenPath,
        pageEvaluator: fake.pageEvaluator,
      });

      const messages = requestBodyFromExpression(fake.request()).messages as Array<{ content: { parts: string[] } }>;
      expect(messages[0].content.parts[0]).toBe("Keep the account owner private.\n\nUse terse answers.\n\nReply with OK only.");
    });
  });
});

function savedConversationStream(conversationId: string, text: string): string {
  return [
    `data: {"message":{"author":{"role":"assistant"},"content":{"content_type":"text","parts":[${JSON.stringify(text)}]},"status":"finished_successfully"},"conversation_id":${JSON.stringify(conversationId)}}`,
    "data: [DONE]",
    "",
  ].join("\n\n");
}

function job(patch: Partial<Pick<JobRecord, "model" | "reasoning">> = {}): JobRecord {
  const now = new Date().toISOString();
  return {
    id: "job_test",
    status: "running",
    prompt: "Reply with OK only.",
    model: patch.model ?? "gpt-5-5-pro",
    reasoning: patch.reasoning ?? "standard",
    options: {
      instructions: "Use terse answers.",
      verbosity: "high",
      reasoningSummary: "detailed",
      toolChoice: "none",
      parallelTools: false,
    },
    result: null,
    error: null,
    createdAt: now,
    updatedAt: now,
  };
}

function jwtFor(account: string, expiresAt: Date): string {
  const payload = { exp: Math.floor(expiresAt.getTime() / 1000), "https://api.openai.com/auth": { chatgpt_account_id: account } };
  return ["header", base64Url(JSON.stringify(payload)), "sig"].join(".");
}

// For tests that must fail before any page access: reading the live Chrome would be a bug.
const pageMustNotBeRead = (async () => {
  throw new Error("The ChatGPT page must not be read here.");
}) as PageEvaluator;

function fakeJwt(): string {
  const payload = {
    exp: Math.floor(Date.now() / 1000) + 3600,
    "https://api.openai.com/auth": { chatgpt_account_id: "acct_test" },
  };
  return ["header", base64Url(JSON.stringify(payload)), "sig"].join(".");
}

function base64Url(value: string): string {
  return Buffer.from(value).toString("base64url");
}

function conversationStream(text: string): string {
  return [
    `data: {"message":{"author":{"role":"assistant"},"content":{"content_type":"text","parts":[${JSON.stringify(text)}]},"status":"finished_successfully"}}`,
    "data: [DONE]",
    "",
  ].join("\n\n");
}

// A long answer stream that ended before the answer finished: the conversation id
// and the user's message arrived, reasoning finished, and no turn terminator followed.
function cutOffStream(conversationId: string, extraFrames: string[] = []): string {
  return [
    'event: delta_encoding\ndata: "v1"',
    `data: {"type":"resume_conversation_token","conversation_id":${JSON.stringify(conversationId)},"token":"resume-token-value"}`,
    `data: {"p":"","o":"add","v":{"message":{"author":{"role":"user"},"content":{"content_type":"text","parts":["secret question text"]},"status":"finished_successfully"},"conversation_id":${JSON.stringify(conversationId)}},"c":0}`,
    'data: {"v":{"message":{"author":{"role":"assistant"},"content":{"content_type":"thoughts","thoughts":[]},"status":"finished_successfully"}},"c":1}',
    ...extraFrames,
    "",
  ].join("\n\n");
}

// The frames of a Pro progress note: a commentary-channel assistant message whose
// text streams in through append patches.
function progressNoteFrames(conversationId: string, note: string): string[] {
  return [
    `data: {"p":"","o":"add","v":{"message":{"author":{"role":"user"},"content":{"content_type":"text","parts":["question"]},"status":"finished_successfully"},"conversation_id":${JSON.stringify(conversationId)}},"c":0}`,
    'data: {"p":"","o":"add","v":{"message":{"author":{"role":"assistant"},"content":{"content_type":"thoughts","thoughts":[]},"status":"in_progress"}},"c":1}',
    'data: {"p":"","o":"add","v":{"message":{"author":{"role":"assistant"},"channel":"commentary","recipient":"all","content":{"content_type":"text","parts":[""]},"status":"in_progress","end_turn":null,"metadata":{"is_thinking_preamble_message":true}}},"c":2}',
    `data: {"p":"/message/content/parts/0","o":"append","v":${JSON.stringify(note.slice(0, 8))}}`,
    `data: {"v":${JSON.stringify(note.slice(8))}}`,
    'data: {"p":"","o":"patch","v":[{"p":"/message/status","o":"replace","v":"finished_successfully"}]}',
  ];
}

function researchLaunchStream(taskId: string, acknowledgement: string): string {
  return [
    `data: {"message":{"author":{"role":"assistant"},"content":{"content_type":"text","parts":[${JSON.stringify(acknowledgement)}]},"status":"finished_successfully"}}`,
    `data: {"v":{"message":{"author":{"role":"tool"},"content":{"content_type":"text","parts":[""]},"status":"finished_successfully","metadata":{"async_task_id":${JSON.stringify(taskId)},"async_task_title":"Research task","async_task_type":"research"}}}}`,
    'data: {"type":"message_stream_complete"}',
    "data: [DONE]",
    "",
  ].join("\n\n");
}

function deepResearchWidgetLaunchStream(conversationId: string, widgetSessionId: string): string {
  const toolCall = JSON.stringify({
    path: "/Deep Research App/implicit_link::connector_openai_deep_research/start",
    args: { user_query: "Research this." },
  });
  return [
    `data: {"conversation_id":${JSON.stringify(conversationId)},"message":{"author":{"role":"assistant"},"recipient":"api_tool.call_tool","content":{"content_type":"text","parts":[${JSON.stringify(toolCall)}]},"status":"finished_successfully"}}`,
    `data: {"v":{"message":{"author":{"role":"tool","name":"api_tool.call_tool"},"content":{"content_type":"code","text":"{}"},"status":"finished_successfully","metadata":{"chatgpt_sdk":{"widget_session_id":${JSON.stringify(widgetSessionId)},"resolved_pineapple_uri":"connectors://connector_openai_deep_research","attribution_id":"connector_openai_deep_research","widget_state":${JSON.stringify(JSON.stringify({ status: "waiting_for_user_response_on_plan", plan: { title: "Connector research" } }))}}}}}}`,
    'data: {"type":"message_stream_complete"}',
    "data: [DONE]",
    "",
  ].join("\n\n");
}

function deepResearchWidgetToolOnlyLaunchStream(conversationId: string, widgetSessionId: string): string {
  return [
    `data: {"conversation_id":${JSON.stringify(conversationId)}}`,
    `data: {"v":{"message":{"author":{"role":"tool","name":"api_tool.call_tool"},"content":{"content_type":"code","text":"{}"},"status":"finished_successfully","metadata":{"chatgpt_sdk":{"widget_session_id":${JSON.stringify(widgetSessionId)},"resolved_pineapple_uri":"connectors://connector_openai_deep_research","attribution_id":"connector_openai_deep_research","widget_state":${JSON.stringify(JSON.stringify({ status: "waiting_for_user_response_on_plan", plan: { title: "Connector research" } }))}}}}}}`,
    'data: {"type":"message_stream_complete"}',
    "data: [DONE]",
    "",
  ].join("\n\n");
}

function researchAckConversationStream(conversationId: string, acknowledgement: string): string {
  return [
    `data: {"conversation_id":${JSON.stringify(conversationId)},"message":{"author":{"role":"assistant"},"content":{"content_type":"text","parts":[${JSON.stringify(acknowledgement)}]},"status":"finished_successfully"}}`,
    'data: {"type":"message_stream_complete"}',
    "data: [DONE]",
    "",
  ].join("\n\n");
}

function imageLaunchStream(conversationId: string): string {
  return [
    `data: {"conversation_id":${JSON.stringify(conversationId)},"message":{"author":{"role":"tool","name":"image_gen"},"content":{"content_type":"multimodal_text","parts":[]},"status":"finished_successfully","metadata":{"ghostrider":{"status":"intermediate"}}}}`,
    `data: {"type":"server_ste_metadata","metadata":{"turn_use_case":"image gen"},"conversation_id":${JSON.stringify(conversationId)}}`,
    `data: {"type":"message_stream_complete","conversation_id":${JSON.stringify(conversationId)}}`,
    "data: [DONE]",
    "",
  ].join("\n\n");
}

function requestBodyFromExpression(expression: string): Record<string, unknown> {
  const marker = '})("https://chatgpt.com/backend-api/f/conversation", ';
  const start = expression.lastIndexOf(marker);
  expect(start).toBeGreaterThanOrEqual(0);
  const bodyStart = start + marker.length;
  const bodyEnd = expression.lastIndexOf(', "acct_test", ');
  expect(bodyEnd).toBeGreaterThan(bodyStart);
  return JSON.parse(expression.slice(bodyStart, bodyEnd)) as Record<string, unknown>;
}

/**
 * Runs the real in-page chat read against a fake ChatGPT: the session endpoint answers with
 * session, and the chat with chat (ChatGPT answers 404 for a chat it shows no one). Other page
 * scripts get other's result.
 */
function chatReadingPage(session: Record<string, unknown>, chat: { status: number; body: unknown }, other: unknown = null) {
  let reads = 0;
  const realFetch = globalThis.fetch;
  const pageEvaluator = (async <T>(_base: string, script: string): Promise<T> => {
    if (!script.includes("fetchConversationAnswer")) return other as T;
    reads += 1;
    globalThis.fetch = (async (url: string | URL | Request) =>
      String(url).endsWith("/api/auth/session")
        ? Response.json(session)
        : Response.json(chat.body, { status: chat.status })) as typeof fetch;
    try {
      return (await (0, eval)(script)) as T;
    } finally {
      globalThis.fetch = realFetch;
    }
  }) as PageEvaluator;
  return { pageEvaluator, reads: () => reads };
}

describe("answer tasks", () => {
  const conversationId = "6ad75a47-4840-83ec-bbaa-e2e703f57bb1";
  const marker = (...fields: string[]) => String.fromCharCode(0xe200) + fields.join(String.fromCharCode(0xe202)) + String.fromCharCode(0xe201);

  test("a chat model's job becomes an answer task once the page names the chat, so a lost browser loses no answer", async () => {
    await withTokenFile(async (sessionTokenPath) => {
      for (const [model, expected] of [["gpt-5-5-pro", 1], ["research", 0]] as const) {
        const tasks: unknown[] = [];
        const pageEvaluator = (async <T>(_base: string, script: string): Promise<T> => {
          if (script.includes("__proCliConversationIds?.[")) return conversationId as T;
          // The request runs until Chrome goes away.
          await Bun.sleep(60);
          throw new Error("WebSocket closed");
        }) as PageEvaluator;

        const outcome = await runChatGptJob(job({ model }), { sessionTokenPath, pageEvaluator, conversationWatchMs: 10, onResearchTask: (task) => void tasks.push(task) })
          .then(() => null, (error: ProError) => error.code);

        expect(outcome).toBe("NETWORK_ERROR");
        expect(tasks).toHaveLength(expected);
        if (expected) expect(tasks[0]).toEqual({ taskId: expect.stringMatching(/^answer:job_test:\d+$/), title: "Answer", conversationId });
      }
    });
  });

  test("a request that ends before the first look registers no answer task", async () => {
    await withTokenFile(async (sessionTokenPath) => {
      const tasks: unknown[] = [];
      const pageEvaluator = (async <T>(_base: string, script: string): Promise<T> =>
        (script.includes("__proCliConversationIds?.[") ? conversationId : { ok: true, status: 200, body: conversationStream("OK") }) as T) as PageEvaluator;

      expect(await runChatGptJob(job(), { sessionTokenPath, pageEvaluator, conversationWatchMs: 50, onResearchTask: (task) => void tasks.push(task) })).toBe("OK");
      await Bun.sleep(80);
      expect(tasks).toEqual([]);
    });
  });

  describe("resumed", () => {
    const task = (startedAt = Date.now() - 1_000) => ({ taskId: `answer:job_lost:${startedAt}`, title: "Answer", conversationId });
    const reads = (results: unknown[]) => {
      let calls = 0;
      const pageEvaluator = (async <T>(): Promise<T> => {
        calls += 1;
        const next = results[Math.min(calls, results.length) - 1];
        if (next instanceof Error) throw next;
        return next as T;
      }) as PageEvaluator;
      return { pageEvaluator, calls: () => calls };
    };
    const codeOf = (promise: Promise<unknown>) => promise.then(() => null, (error: ProError) => error.code);

    test("reads the answer from the chat and formats its citations", async () => {
      await withTokenFile(async (sessionTokenPath) => {
        const sources = { search_result_groups: [{ entries: [
          { url: "https://bun.com/blog/bun-v1.4.3", title: "Bun v1.4.3", ref_id: { turn_index: 0, ref_type: "search", ref_index: 0 } },
        ] }] };
        const browser = reads([
          { ok: true, status: 200, state: "pending", text: null, message: "assistant text in_progress" },
          { ok: true, status: 200, state: "done", text: `Bun 1.4.3 is out. ${marker("cite", "turn0search0")}`, message: null, sources },
        ]);

        const answer = await runChatGptResearchTask(task(), { sessionTokenPath, pageEvaluator: browser.pageEvaluator, citations: "numbered", streamRecoveryPollMs: 0 });

        expect(answer).toBe("Bun 1.4.3 is out. [1]\n\nSources:\n[1] Bun v1.4.3 — https://bun.com/blog/bun-v1.4.3\n");
        expect(browser.calls()).toBe(2);
      });
    });

    test("waits with NETWORK_ERROR while the chat cannot be read, and ends with ANSWER_NOT_RECOVERED", async () => {
      await withTokenFile(async (sessionTokenPath) => {
        const options = { sessionTokenPath, streamRecoveryPollMs: 0 };
        expect(await codeOf(runChatGptResearchTask(task(), { ...options, ...reads([new Error("CDP down")]) }))).toBe("NETWORK_ERROR");
        const empty = reads([{ ok: true, status: 200, state: "empty", text: null, message: "assistant text finished_successfully" }]);
        expect(await codeOf(runChatGptResearchTask(task(), { ...options, pageEvaluator: empty.pageEvaluator }))).toBe("ANSWER_NOT_RECOVERED");
        const gone = reads([{ ok: false, status: 404, state: "pending", text: null, message: null }]);
        expect(await codeOf(runChatGptResearchTask(task(), { ...options, pageEvaluator: gone.pageEvaluator }))).toBe("ANSWER_NOT_RECOVERED");
        // Past the request's 3-hour wait, the chat is read once more.
        const late = reads([{ ok: true, status: 200, state: "pending", text: null, message: "assistant thoughts in_progress" }]);
        expect(await codeOf(runChatGptResearchTask(task(Date.now() - 4 * 60 * 60_000), { ...options, pageEvaluator: late.pageEvaluator }))).toBe("ANSWER_NOT_RECOVERED");
        expect(late.calls()).toBe(1);
      });
    });

    test("waits while the page is logged out instead of taking its 404 for a gone chat, until the request's wait is over", async () => {
      await withTokenFile(async (sessionTokenPath) => {
        const options = { sessionTokenPath, streamRecoveryPollMs: 0 };
        const notFound = { status: 404, body: { detail: "Conversation not found" } };
        for (const [startedAt, code] of [[Date.now() - 1_000, "CHATGPT_PAGE_LOGGED_OUT"], [Date.now() - 4 * 60 * 60_000, "ANSWER_NOT_RECOVERED"]] as const) {
          const loggedOut = chatReadingPage({}, notFound);
          const error = await runChatGptResearchTask(task(startedAt), { ...options, pageEvaluator: loggedOut.pageEvaluator })
            .then(() => null, (thrown: ProError) => thrown);
          expect(error?.code).toBe(code);
          expect(error?.details).toMatchObject({ conversationId, recovery: { state: "logged_out", status: 404, polls: 1 } });
          expect(loggedOut.reads()).toBe(1);
        }
        // Logged in, a 404 means the chat is gone.
        const gone = chatReadingPage({ accessToken: "tok" }, notFound);
        expect(await codeOf(runChatGptResearchTask(task(), { ...options, pageEvaluator: gone.pageEvaluator }))).toBe("ANSWER_NOT_RECOVERED");
        expect(gone.reads()).toBe(3);
      });
    });

    test("takes the answer once the page is logged in again, though the request's wait is over", async () => {
      await withTokenFile(async (sessionTokenPath) => {
        const startedAt = Date.now() - 6 * 60 * 60_000;
        const asked = startedAt / 1000 + 1;
        const page = chatReadingPage({ accessToken: "tok" }, {
          status: 200,
          body: {
            current_node: "final",
            mapping: {
              user: { message: { author: { role: "user" }, content: { content_type: "text", parts: ["q"] }, status: "finished_successfully", create_time: asked } },
              final: { message: { author: { role: "assistant" }, channel: "final", recipient: "all", content: { content_type: "text", parts: ["Stored answer."] }, status: "finished_successfully", end_turn: true, create_time: asked + 1800 } },
            },
          },
        });

        expect(await runChatGptResearchTask(task(startedAt), { sessionTokenPath, pageEvaluator: page.pageEvaluator, streamRecoveryPollMs: 0 })).toBe("Stored answer.");
        expect(page.reads()).toBe(1);
      });
    });
  });

  test("a stream lost as the page logs out goes to the answer task without polling the chat's 404", async () => {
    await withTokenFile(async (sessionTokenPath) => {
      const page = chatReadingPage({}, { status: 404, body: { detail: "Conversation not found" } }, { ok: true, status: 200, body: cutOffStream("conv_out") });

      const error = await runChatGptJob(job(), { sessionTokenPath, pageEvaluator: page.pageEvaluator, streamRecoveryPollMs: 0 })
        .then(() => null, (thrown: ProError) => thrown);

      expect(error?.code).toBe("STREAM_INCOMPLETE");
      expect(error?.details).toMatchObject({ conversationId: "conv_out", recovery: { state: "logged_out", status: 404, polls: 1 } });
      expect(page.reads()).toBe(1);
    });
  });
});
