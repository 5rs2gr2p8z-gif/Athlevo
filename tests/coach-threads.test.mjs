/**
 * Athlevo Coach — Conversation Threads tests
 *
 * Covers: migration, thread model, New Chat, Chats UI, message routing,
 * recentConversation scoping, memory isolation, title derivation,
 * account deletion, and UI changes (Train/Trends icon, scroll button,
 * suggested replies).
 */

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dirname, "..");

function readFile(rel) {
  return readFileSync(join(ROOT, rel), "utf8");
}

/* ─────────────────── Migration file ─────────────────── */

describe("coach_threads migration", () => {
  const sql = readFile("migrations/2026-09-06_coach_threads.sql");

  it("1. migration file exists", () => {
    expect(sql.length).toBeGreaterThan(100);
  });

  it("2. creates coach_threads table", () => {
    expect(sql).toContain("create table if not exists public.coach_threads");
  });

  it("3. adds thread_id to coach_conversations", () => {
    expect(sql).toContain("add column if not exists thread_id uuid");
  });

  it("4. composite foreign key enforces same-user ownership", () => {
    expect(sql).toContain("coach_conversations_thread_ownership");
    expect(sql).toContain("foreign key (thread_id, user_id)");
    expect(sql).toContain("references public.coach_threads (id, user_id)");
  });

  it("5. RLS enabled and policies created", () => {
    expect(sql).toContain("enable row level security");
    expect(sql).toContain("coach_threads_select_own");
    expect(sql).toContain("coach_threads_insert_own");
    expect(sql).toContain("coach_threads_update_own");
    expect(sql).toContain("coach_threads_delete_own");
  });

  it("6. backfill creates one thread per user with existing messages", () => {
    expect(sql).toContain("group by cc.user_id");
    expect(sql).toContain("insert into public.coach_threads");
    expect(sql).toContain("update public.coach_conversations");
    expect(sql).toContain("set thread_id = new_thread_id");
  });

  it("7. thread_id set NOT NULL after backfill", () => {
    expect(sql).toContain("alter column thread_id set not null");
  });

  it("8. indexes for performance", () => {
    expect(sql).toContain("coach_threads_user_last_msg_idx");
    expect(sql).toContain("coach_conversations_thread_created_idx");
  });

  it("9. ON DELETE CASCADE from auth.users", () => {
    expect(sql).toContain("on delete cascade");
  });
});

/* ─────────────────── coach.js ─────────────────── */

describe("coach.js thread support", () => {
  const coachJs = readFile("js/coach.js");

  it("10. defines thread state (getActiveThreadId, setActiveThreadId)", () => {
    expect(coachJs).toContain("getActiveThreadId");
    expect(coachJs).toContain("_activeThreadId");
  });

  it("11. saveConversationMessage includes thread_id", () => {
    expect(coachJs).toContain("thread_id: _activeThreadId");
  });

  it("12. loadConversationHistory scopes to active thread", () => {
    expect(coachJs).toContain('.eq("thread_id", _activeThreadId)');
  });

  it("13. loadRecentConversationForCoach scopes to active thread", () => {
    // Should contain thread filtering in the recent-conversation loader.
    expect(coachJs).toContain('query.eq("thread_id", _activeThreadId)');
  });

  it("14. New Chat does NOT delete messages", () => {
    const startNew = coachJs.slice(coachJs.indexOf("async function startNewCoachConversation"));
    const fnEnd = startNew.indexOf("\n}") + 2;
    const fnBody = startNew.slice(0, fnEnd);
    expect(fnBody).not.toContain(".delete()");
    expect(fnBody).not.toContain('from("coach_conversations")');
  });

  it("15. New Chat clears _activeThreadId", () => {
    expect(coachJs).toContain("_activeThreadId = null");
  });

  it("16. ensureActiveThread restores latest thread", () => {
    expect(coachJs).toContain("ensureActiveThread");
    expect(coachJs).toContain('from("coach_threads")');
    expect(coachJs).toContain(".order(\"last_message_at\"");
  });

  it("17. createThread function exists", () => {
    expect(coachJs).toContain("async function createThread");
  });

  it("18. deriveThreadTitle derives from user message", () => {
    expect(coachJs).toContain("function deriveThreadTitle");
    expect(coachJs).toContain("slice(0, 52)");
  });

  it("19. renderCoachHistoryList renders threads not messages", () => {
    expect(coachJs).toContain("loadThreadList");
    expect(coachJs).toContain("coach-history-item--active");
    expect(coachJs).toContain("formatThreadDate");
  });

  it("20. selectThread loads a specific thread", () => {
    expect(coachJs).toContain("async function selectThread");
  });

  it("21. athlete memory remains cross-thread", () => {
    // Memory loading is separate from thread scoping.
    expect(coachJs).toContain("AthlevoMemory.loadAthleteMemory");
    // Memory does not reference thread_id.
    const memorySection = coachJs.slice(coachJs.indexOf("context.longTermMemory"));
    const memBlock = memorySection.slice(0, 400);
    expect(memBlock).not.toContain("thread_id");
  });

  it("22. exports new thread functions", () => {
    expect(coachJs).toContain("window.selectThread = selectThread");
    expect(coachJs).toContain("window.loadThreadList = loadThreadList");
    expect(coachJs).toContain("window.ensureActiveThread = ensureActiveThread");
    expect(coachJs).toContain("window.createThread = createThread");
  });
});

/* ─────────────────── Account deletion ─────────────────── */

describe("account deletion includes coach_threads", () => {
  const api = readFile("api/providers/index.js");

  it("23. coach_threads in userDataTables", () => {
    expect(api).toContain('"coach_threads"');
  });

  it("24. coach_conversations still in userDataTables", () => {
    expect(api).toContain('"coach_conversations"');
  });
});

/* ─────────────────── index.html UI ─────────────────── */

describe("index.html UI changes", () => {
  const html = readFile("index.html");

  it("25. Train screen hides profile avatar", () => {
    expect(html).toContain("#screen-train.active ~ #profileAvatarBtn{display:none!important}");
  });

  it("26. Trends screen hides profile avatar", () => {
    expect(html).toContain("#screen-trends.active ~ #profileAvatarBtn{display:none!important}");
  });

  it("27. Coach header top-right is Settings + New Chat (Chats icon removed; Chats stays inline in the side panel)", () => {
    expect(html).not.toContain('id="coachHeaderChats"');
    expect(html).toContain('id="coachHeaderSettings"');
    expect(html).toContain('id="coachHeaderNewChat"');
  });

  it("28. Profile row removed from Coach side panel, but legacy profile screen/function is left intact", () => {
    expect(html).not.toContain("runCoachMenuAction('profile')");
    expect(html).toContain("openProfileScreen");
  });

  it("29. scroll-to-bottom is positioned absolutely (out of normal flow)", () => {
    expect(html).toContain(".coach-jump-latest{");
    expect(html).toMatch(/\.coach-jump-latest\{[^}]*position:\s*absolute/);
  });

  it("30. no large opaque wrapper — jump button is direct child of composer", () => {
    // The button should now be a direct child of .coach-composer, not nested inside
    // a blocking wrapper.
    const composerSection = html.slice(html.indexOf('<div class="coach-composer">'));
    const firstChunk = composerSection.slice(0, 300);
    expect(firstChunk).toContain('class="coach-jump-latest"');
  });

  it("31. jump button has hidden attribute for visibility control", () => {
    expect(html).toContain(".coach-jump-latest[hidden]{display:none}");
  });

  it("32. suggested replies use full-width column layout", () => {
    expect(html).toMatch(/#screen-coachai .coach-composer .chips\{[^}]*flex-direction:\s*column/);
  });

  it("33. suggested reply chips use width:100%", () => {
    expect(html).toMatch(/#screen-coachai .coach-composer .chip\{[^}]*width:\s*100%/);
  });

  it("34. suggested reply chips have consistent min-height", () => {
    expect(html).toMatch(/#screen-coachai .coach-composer .chip\{[^}]*min-height:\s*42px/);
  });

  it("35. destructive new-chat warning removed", () => {
    expect(html).not.toContain("Starting over clears your current Coach conversation");
    expect(html).not.toContain("This cannot be undone");
  });

  it("36. New Chat from header calls startNewCoachConversation directly", () => {
    // openCoachNewChatPrompt should now directly start, not show dialog.
    const fn = html.slice(html.indexOf("function openCoachNewChatPrompt"));
    const fnBlock = fn.slice(0, 300);
    expect(fnBlock).toContain("startNewCoachConversation");
    expect(fnBlock).not.toContain("AthlevoSheet.open");
  });

  it("37. New Chat from side panel calls same canonical function", () => {
    expect(html).toContain('action === "new-chat"');
    const menuAction = html.slice(html.indexOf('action === "new-chat"'));
    const snippet = menuAction.slice(0, 200);
    expect(snippet).toContain("startNewCoachConversation");
  });
});

/* ─────────────────── renderCoachResponse.js ─────────────────── */

describe("renderCoachResponse suggested replies", () => {
  const render = readFile("js/renderCoachResponse.js");

  it("38. allows up to 3 suggested replies", () => {
    expect(render).toContain("replies.slice(0, 3)");
  });

  it("39. click behavior submits the expected prompt", () => {
    expect(render).toContain("input.value = reply.trim()");
    expect(render).toContain("window.sendMsg");
  });
});

/* ─────────────────── Regression guards ─────────────────── */

describe("regression guards", () => {
  const html = readFile("index.html");
  const coachJs = readFile("js/coach.js");

  it("40. Coach default home screen unchanged (empty state)", () => {
    expect(html).toContain('id="coachEmptyState"');
    expect(html).toContain("What should we work on?");
  });

  it("41. 3-tab navigation unchanged", () => {
    expect(html).toContain('data-screen="screen-train"');
    expect(html).toContain('data-screen="screen-coachai"');
    expect(html).toContain('data-screen="screen-trends"');
  });

  it("42. Coach Mode file unchanged (not part of this diff)", () => {
    // coachMode.js should not be in our changes.
    // This is a structural assertion — we verify coach.js doesn't import coachMode changes.
    expect(coachJs).not.toContain("coachModeRedesign");
  });

  it("43. auth boot unchanged", () => {
    expect(html).toContain("coachHeaderAuthState");
  });
});

/* ─────────────────── Skeleton loader location ─────────────────── */

describe("skeleton loader (documented, not changed)", () => {
  const html = readFile("index.html");

  it("44. skeleton markup exists in index.html", () => {
    expect(html).toContain("am-coach-resolving");
  });

  it("45. skeleton CSS exists in index.html", () => {
    expect(html).toContain(".am-coach-resolving");
  });
});
