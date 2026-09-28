/* eslint-env jest, node */
jest.mock("../../../utils/EmbeddingRerankers/native/index.js", () => ({
  NativeEmbeddingReranker: jest.fn(),
}));

const {
  NativeEmbeddingReranker,
} = require("../../../utils/EmbeddingRerankers/native/index.js");
const {
  promptWithSkills,
  selectRelevantSkills,
  formatSkillsSection,
  getSkillDetectionStatus,
  MAX_INJECTED_SKILLS,
} = require("../../../utils/skills");

const skill = (name, description, body = `Body for ${name}`) => ({
  name,
  description,
  body,
});

function makeStore(skills) {
  return { list: jest.fn(() => skills) };
}

/**
 * Reranker mock that scores docs by how often query words appear in them.
 * Matching docs get a positive logit (sigmoid > 0.5), non-matching docs get a
 * negative one (sigmoid < 0.5), mirroring a real relevance signal.
 */
function mockRelevanceReranker() {
  NativeEmbeddingReranker.mockImplementation(() => ({
    rerank: jest.fn(async (query, documents, { topK }) => {
      const scored = documents.map((doc, i) => {
        // Ignore stopword-sized tokens so "a"/"for" don't create false matches.
        const matches = query
          .split(/\s+/)
          .filter((w) => w.length > 2 && doc.text.toLowerCase().includes(w.toLowerCase()))
          .length;
        // Require >= 2 distinct matches for a "relevant" (positive logit)
        // score, so single stopword-ish overlaps don't count as relevant.
        return {
          rerank_corpus_id: i,
          rerank_score: matches >= 2 ? matches * 3 : -3,
        };
      });
      return scored
        .sort((a, b) => b.rerank_score - a.rerank_score)
        .slice(0, topK);
    }),
  }));
}

describe("promptWithSkills", () => {
  beforeEach(() => jest.clearAllMocks());

  it("returns the prompt unchanged when there are no skills", async () => {
    const out = await promptWithSkills({
      systemPrompt: "BASE",
      skillStore: makeStore([]),
    });
    expect(out).toBe("BASE");
  });

  it("appends a Skills section when skills are present", async () => {
    mockRelevanceReranker();
    const out = await promptWithSkills({
      systemPrompt: "BASE",
      prompt: "help me write a commit message",
      skillStore: makeStore([
        skill("git-commits", "Writing commit messages. Use for git commits."),
      ]),
    });
    expect(out.startsWith("BASE")).toBe(true);
    expect(out).toContain("## Skills");
    expect(out).toContain("### Skill: git-commits");
    expect(out).toContain("Body for git-commits");
  });

  it("reranks even at or under the limit so irrelevant skills are not injected", async () => {
    mockRelevanceReranker();
    const skills = [
      skill("git-commits", "Writing commit messages for git repositories"),
      skill("lucky-number", "Picks a lucky number between 1 and 100"),
    ];
    const out = await promptWithSkills({
      systemPrompt: "BASE",
      prompt: "help me write a commit message",
      skillStore: makeStore(skills),
    });
    expect(NativeEmbeddingReranker).toHaveBeenCalledTimes(1);
    expect(out).toContain("### Skill: git-commits");
  });

  it("injects no skills when nothing is relevant to the prompt", async () => {
    // Mirrors the "lucky number" skill vs "capital of France" case: the
    // reranker scores the skill's metadata against the prompt.
    NativeEmbeddingReranker.mockImplementation(() => ({
      rerank: jest.fn(async (query, documents, { topK }) =>
        documents.slice(0, topK).map((_, i) => ({
          rerank_corpus_id: i,
          rerank_score: -2, // sigmoid(-2) ~ 0.12 < 0.5 threshold
        }))
      ),
    }));
    const out = await promptWithSkills({
      systemPrompt: "BASE",
      prompt: "What is the capital of France?",
      skillStore: makeStore([
        skill("lucky-number", "Picks a random lucky number between 1 and 100"),
      ]),
    });
    expect(out).toBe("BASE");
    expect(out).not.toContain("## Skills");
    expect(getSkillDetectionStatus().mode).toBe("reranked");
    expect(getSkillDetectionStatus().count).toBe(0);
  });

  it("reranks and keeps only the top N when over the limit", async () => {
    // Every skill except sql-queries is unrelated to the prompt, so only the
    // matching skill clears the relevance threshold.
    mockRelevanceReranker();
    const skills = [
      skill("sql-queries", "Writing SQL queries for postgres databases"),
      skill("recipe-box", "Cooking recipes and baking"),
      skill("garden-tips", "Gardening care for tomato plants"),
      skill("travel-plans", "Travel itinerary planning"),
      skill("code-review", "Reviewing pull requests"),
      skill("poem-writer", "Writing poems"),
    ];
    const out = await promptWithSkills({
      systemPrompt: "BASE",
      prompt: "write a SQL query for my postgres database",
      skillStore: makeStore(skills),
    });

    expect(NativeEmbeddingReranker).toHaveBeenCalledTimes(1);
    const injected = (out.match(/### Skill: ([\w-]+)/g) || []).map((s) =>
      s.replace("### Skill: ", "")
    );
    expect(injected).toEqual(["sql-queries"]);
  });

  it("caps the injected set at the limit when many skills are relevant", async () => {
    // All docs score identically high; the reranker returns at most topK.
    NativeEmbeddingReranker.mockImplementation(() => ({
      rerank: jest.fn(async (query, documents, { topK }) =>
        documents.slice(0, topK).map((_, i) => ({
          rerank_corpus_id: i,
          rerank_score: 3,
        }))
      ),
    }));
    const skills = Array.from(
      { length: MAX_INJECTED_SKILLS + 2 },
      (_, i) => skill(`s-${i}`, `desc ${i}`)
    );
    const out = await promptWithSkills({
      systemPrompt: "BASE",
      prompt: "anything",
      skillStore: makeStore(skills),
    });
    expect((out.match(/### Skill:/g) || []).length).toBe(MAX_INJECTED_SKILLS);
  });

  it("caps each injected body at the max length", async () => {
    NativeEmbeddingReranker.mockImplementation(() => ({
      rerank: jest.fn(async (query, documents, { topK }) =>
        documents.slice(0, topK).map((_, i) => ({
          rerank_corpus_id: i,
          rerank_score: 3,
        }))
      ),
    }));
    const huge = skill("huge-skill", "big body", "x".repeat(20000));
    const out = await promptWithSkills({
      systemPrompt: "BASE",
      prompt: "test",
      skillStore: makeStore([huge]),
    });
    const bodyMatch = out.match(/### Skill: huge-skill\n+([\s\S]*)$/);
    expect(bodyMatch[1].length).toBeLessThanOrEqual(12000 + 10);
  });

  it("returns the original prompt when the store throws", async () => {
    NativeEmbeddingReranker.mockImplementation(() => ({
      rerank: jest.fn(async (query, documents, { topK }) =>
        documents.slice(0, topK).map((_, i) => ({
          rerank_corpus_id: i,
          rerank_score: 3,
        }))
      ),
    }));
    const out = await promptWithSkills({
      systemPrompt: "BASE",
      skillStore: { list: jest.fn(() => { throw new Error("disk on fire"); }) },
    });
    expect(out).toBe("BASE");
  });

  it("ignores broken entries ({ dir, error }) coming from store.list()", async () => {
    const out = await promptWithSkills({
      systemPrompt: "BASE",
      prompt: "anything",
      skillStore: {
        list: jest.fn(() => [
          skill("good-skill", "a description"),
          { dir: "broken-skill", error: "Missing SKILL.md file." },
        ]),
      },
    });
    expect(out).toContain("### Skill: good-skill");
    expect(out).not.toContain("broken-skill");
  });

  it("exercises the boundary: exactly MAX skills are still reranked", async () => {
    NativeEmbeddingReranker.mockImplementation(() => ({
      rerank: jest.fn(async (query, documents, { topK }) =>
        documents.slice(0, topK).map((_, i) => ({
          rerank_corpus_id: i,
          rerank_score: 3, // sigmoid(3) ~ 0.95, clears the default threshold
        }))
      ),
    }));
    const skills = Array.from(
      { length: MAX_INJECTED_SKILLS },
      (_, i) => skill(`s-${i}`, `desc ${i}`)
    );
    const out = await promptWithSkills({
      systemPrompt: "BASE",
      prompt: "anything",
      skillStore: makeStore(skills),
    });
    expect(NativeEmbeddingReranker).toHaveBeenCalledTimes(1);
    expect((out.match(/### Skill:/g) || []).length).toBe(MAX_INJECTED_SKILLS);
    expect(getSkillDetectionStatus().mode).toBe("reranked");
  });

  it("uses the reranker with MAX+1 skills", async () => {
    mockRelevanceReranker();
    const skills = Array.from(
      { length: MAX_INJECTED_SKILLS + 1 },
      (_, i) => skill(`s-${i}`, `desc ${i}`)
    );
    await promptWithSkills({
      systemPrompt: "BASE",
      prompt: "anything",
      skillStore: makeStore(skills),
    });
    expect(NativeEmbeddingReranker).toHaveBeenCalledTimes(1);
    expect(getSkillDetectionStatus().mode).toBe("reranked");
  });

  it("records a fallback status when the reranker is unavailable", async () => {
    NativeEmbeddingReranker.mockImplementation(
      () => ({ rerank: jest.fn(async () => { throw new Error("no model"); }) })
    );
    const skills = Array.from(
      { length: MAX_INJECTED_SKILLS + 1 },
      (_, i) => skill(`s-${i}`, `desc ${i}`)
    );
    await promptWithSkills({
      systemPrompt: "BASE",
      prompt: "anything",
      skillStore: makeStore(skills),
    });
    const status = getSkillDetectionStatus();
    expect(status.mode).toBe("fallback");
    expect(status.reason).toBe("no model");
    expect(status.count).toBe(MAX_INJECTED_SKILLS);
  });
});

describe("selectRelevantSkills", () => {
  beforeEach(() => jest.clearAllMocks());

  it("passes recent history into the rerank query", async () => {
    let rerankSpy;
    NativeEmbeddingReranker.mockImplementation(() => ({
      rerank: (rerankSpy = jest.fn(async (q, docs, { topK }) =>
        docs.slice(0, topK).map((_, i) => ({ rerank_corpus_id: i, rerank_score: 1 }))
      )),
    }));
    const skills = Array.from({ length: 7 }, (_, i) => skill(`s-${i}`, `desc ${i}`));
    await selectRelevantSkills(skills, "current message", [
      { prompt: "earlier context about sql" },
    ]);
    expect(rerankSpy).toHaveBeenCalledTimes(1);
    const [query] = rerankSpy.mock.calls[0];
    expect(query).toContain("current message");
    expect(query).toContain("earlier context about sql");
  });

  it("falls back to the first N skills when the reranker fails", async () => {
    NativeEmbeddingReranker.mockImplementation(
      () => ({ rerank: jest.fn(async () => { throw new Error("no model"); }) })
    );
    const skills = Array.from({ length: 8 }, (_, i) => skill(`s-${i}`, `desc ${i}`));
    const selected = await selectRelevantSkills(skills, "anything", []);
    expect(selected.map((s) => s.name)).toEqual(
      skills.slice(0, MAX_INJECTED_SKILLS).map((s) => s.name)
    );
  });

  it("reranks even under the limit when a threshold is in effect", async () => {
    NativeEmbeddingReranker.mockImplementation(() => ({
      rerank: jest.fn(async (query, documents, { topK }) =>
        documents.slice(0, topK).map((_, i) => ({
          rerank_corpus_id: i,
          rerank_score: 3,
        }))
      ),
    }));
    const skills = [skill("a"), skill("b"), skill("c")];
    const selected = await selectRelevantSkills(skills, "q", [], 5, 0.5);
    expect(selected.map((s) => s.name)).toEqual(["a", "b", "c"]);
    expect(NativeEmbeddingReranker).toHaveBeenCalledTimes(1);
  });

  it("skips reranking entirely when the threshold is 0 (legacy mode)", async () => {
    const skills = [skill("a"), skill("b"), skill("c")];
    expect(await selectRelevantSkills(skills, "q", [], 5, 0)).toBe(skills);
    expect(NativeEmbeddingReranker).not.toHaveBeenCalled();
  });

  it("drops skills below the threshold even when over the limit would apply", async () => {
    NativeEmbeddingReranker.mockImplementation(() => ({
      rerank: jest.fn(async (query, documents, { topK }) =>
        documents.slice(0, topK).map((_, i) => ({
          rerank_corpus_id: i,
          rerank_score: i === 0 ? 3 : -2,
        }))
      ),
    }));
    const skills = Array.from({ length: 8 }, (_, i) => skill(`s-${i}`, `desc ${i}`));
    const selected = await selectRelevantSkills(skills, "q", [], 5, 0.5);
    expect(selected.map((s) => s.name)).toEqual(["s-0"]);
  });
});

describe("formatSkillsSection", () => {
  it("returns an empty string for no skills", () => {
    expect(formatSkillsSection([])).toBe("");
  });

  it("labels each skill with its name and body", () => {
    const section = formatSkillsSection([skill("one", "d", "B1"), skill("two", "d", "B2")]);
    expect(section).toContain("## Skills");
    expect(section).toContain("### Skill: one");
    expect(section).toContain("B1");
    expect(section).toContain("### Skill: two");
    expect(section).toContain("B2");
  });
});
