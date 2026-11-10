import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { CircleNotch } from "@phosphor-icons/react";
import debounce from "lodash.debounce";
import System from "@/models/system";
import Admin from "@/models/admin";

/** Slider granularity: 5% increments. */
const STEP = 0.05;

/**
 * Setting for the minimum relevance (0-1) a markdown skill must clear to be
 * injected into the system prompt. Skills are scored by the embedding
 * reranker against the current prompt; anything below this threshold is
 * skipped so irrelevant skills never cost tokens. 0 disables filtering and
 * always injects up to the injection limit.
 */
export default function MarkdownSkillRelevanceThreshold() {
  const { t } = useTranslation();
  const [threshold, setThreshold] = useState(0.5);
  const [loading, setLoading] = useState(true);

  const debouncedUpdateThreshold = useMemo(
    () =>
      debounce(async (value) => {
        await Admin.updateSystemPreferences({
          markdown_skills_relevance_threshold: String(value),
        });
      }, 800),
    []
  );

  useEffect(() => {
    System.keys()
      .then(async (res) => {
        const raw = Number(res.MarkdownSkillsRelevanceThreshold);
        const value = Number.isFinite(raw) ? raw : 0.5;
        // Snap to the step grid so the readout always matches the step size.
        // Round to 2 decimals to avoid float artifacts (e.g. 10 * 0.05).
        const snapped = Math.round(Math.round(value / STEP) * STEP * 100) / 100;
        setThreshold(snapped);
        if (snapped !== value) {
          await Admin.updateSystemPreferences({
            markdown_skills_relevance_threshold: String(snapped),
          });
        }
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    return () => {
      debouncedUpdateThreshold.cancel();
    };
  }, [debouncedUpdateThreshold]);

  return (
    <div className="flex flex-col gap-y-2">
      <div className="flex items-center gap-x-1">
        <label className="block text-md font-medium text-zinc-50 light:text-slate-900">
          {t("agent.settings.markdown-skill-relevance.title")}
        </label>
      </div>
      <p className="text-xs text-zinc-400 light:text-slate-600">
        {t("agent.settings.markdown-skill-relevance.description")}
      </p>
      {loading ? (
        <CircleNotch
          size={16}
          className="animate-spin text-zinc-400 light:text-slate-600"
        />
      ) : (
        <div className="flex items-center gap-x-3">
          <span className="text-[10px] uppercase tracking-wide text-zinc-500 light:text-slate-500">
            {t("agent.settings.markdown-skill-relevance.low")}
          </span>
          <input
            type="range"
            name="markdownSkillRelevanceThreshold"
            min={0}
            max={1}
            step={STEP}
            value={threshold}
            onChange={(e) => {
              const value = Number(e.target.value);
              if (Number.isNaN(value)) return;
              setThreshold(value);
              debouncedUpdateThreshold(value);
            }}
            className="flex-1 accent-sky-500 h-2 cursor-pointer"
          />
          <span className="text-[10px] uppercase tracking-wide text-zinc-500 light:text-slate-500">
            {t("agent.settings.markdown-skill-relevance.high")}
          </span>
          <span className="bg-zinc-800 border border-zinc-800 light:bg-white light:border-slate-300 text-zinc-100 light:text-slate-900 text-sm rounded-lg block w-[64px] h-[34px] px-2 text-center tabular-nums">
            {Math.round(threshold * 100)}%
          </span>
        </div>
      )}
    </div>
  );
}
