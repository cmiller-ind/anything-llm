import { useState, useEffect } from "react";
import { useParams } from "react-router-dom";
import PreLoader from "@/components/Preloader";
import { useTranslation } from "react-i18next";
import { PROVIDER_SETUP_EVENT, SAVE_LLM_SELECTOR_EVENT } from "./action";
import { PROVIDER_DEFAULT_MODELS } from "@/hooks/useGetProvidersModels";
import { WORKSPACE_LLM_PROVIDERS, hasMissingCredentials } from "./utils";
import { NoSetupWarning } from "./SetupProvider";
import showToast from "@/utils/toast";
import Workspace from "@/models/workspace";
import System from "@/models/system";
import ModelRouter from "@/models/modelRouter";

export default function LLMSelectorModal({
  workspaceSlug = null,
  initialProvider = null,
}) {
  const { slug: urlSlug } = useParams();
  const slug = urlSlug ?? workspaceSlug;
  const { t } = useTranslation();
  const [loading, setLoading] = useState(false);
  const [settings, setSettings] = useState(null);
  const [selectedLLMProvider, setSelectedLLMProvider] = useState(null);
  const [selectedLLMModel, setSelectedLLMModel] = useState("");
  const [selectedRouterId, setSelectedRouterId] = useState(null);
  const [availableModels, setAvailableModels] = useState([]);
  const [modelsLoading, setModelsLoading] = useState(true);
  const [hasChanges, setHasChanges] = useState(false);
  const [saving, setSaving] = useState(false);
  const [missingCredentials, setMissingCredentials] = useState(false);

  useEffect(() => {
    if (!slug) return;
    setLoading(true);
    let cancelled = false;
    Promise.all([Workspace.bySlug(slug), System.keys()])
      .then(async ([workspace, systemSettings]) => {
        const savedProvider =
          workspace.chatProvider ?? systemSettings.LLMProvider;
        const savedModel = workspace.chatModel ?? systemSettings.LLMModel;
        const providerToSelect = initialProvider ?? savedProvider;
        const routerId =
          workspace.router_id || systemSettings?.ModelRouterId || null;
        const modelToSelect =
          providerToSelect === "anythingllm-router" ? routerId : savedModel;

        if (cancelled) return;
        setSettings(systemSettings);
        setSelectedLLMProvider(providerToSelect);
        setSelectedLLMModel(modelToSelect || "");
        setSelectedRouterId(routerId);

        if (initialProvider && initialProvider !== savedProvider) {
          setHasChanges(true);
          setMissingCredentials(
            hasMissingCredentials(systemSettings, initialProvider)
          );
        }

        setModelsLoading(true);
        const configuredProviders = WORKSPACE_LLM_PROVIDERS.filter(
          (provider) =>
            provider.value !== "anythingllm-router" &&
            !hasMissingCredentials(systemSettings, provider.value)
        );
        const [providerModels, routers] = await Promise.all([
          Promise.all(
            configuredProviders.map(async (provider) => {
              const { models = [] } = await System.customModels(provider.value);
              const discoveredModels = Array.isArray(models)
                ? models
                : Object.values(models).flat();
              const modelsById = new Map();

              for (const model of [
                ...(PROVIDER_DEFAULT_MODELS[provider.value] || []),
                ...discoveredModels,
              ]) {
                const modelId = typeof model === "string" ? model : model?.id;
                if (!modelId || modelsById.has(modelId)) continue;
                modelsById.set(modelId, {
                  provider: provider.value,
                  model: modelId,
                  label:
                    typeof model === "string" ? model : model.name || model.id,
                  providerName: provider.name,
                });
              }

              return [...modelsById.values()];
            })
          ),
          ModelRouter.getAll(),
        ]);
        const modelOptions = [
          ...providerModels.flat(),
          ...routers.map((router) => ({
            provider: "anythingllm-router",
            model: String(router.id),
            label: router.name,
            providerName: "Model Router",
          })),
        ];

        if (cancelled) return;
        setAvailableModels(modelOptions);
        setModelsLoading(false);
      })
      .catch((error) => console.error(error))
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
          setModelsLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [slug]);

  function handleModelSelection(value) {
    const [provider, model] = JSON.parse(value);
    setSelectedLLMProvider(provider);
    setSelectedLLMModel(model);
    setSelectedRouterId(
      provider === "anythingllm-router" ? Number(model) : null
    );
    setMissingCredentials(false);
    setHasChanges(true);
  }

  async function handleSave() {
    setSaving(true);
    try {
      setHasChanges(false);

      const isRouter = selectedLLMProvider === "anythingllm-router";
      if (isRouter && !selectedRouterId)
        throw new Error(t("model-router.chat.select-router-error"));

      const updateData = isRouter
        ? { chatProvider: selectedLLMProvider, router_id: selectedRouterId }
        : {
            chatProvider: selectedLLMProvider,
            chatModel: selectedLLMModel,
          };

      if (!isRouter && !selectedLLMModel)
        throw new Error(t("model-router.chat.invalid-model"));

      const { message } = await Workspace.update(slug, updateData);

      if (!!message) throw new Error(message);
      window.dispatchEvent(new Event(SAVE_LLM_SELECTOR_EVENT));
    } catch (error) {
      console.error(error);
      showToast(error.message, "error", { clear: true });
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div
        id="llm-selector-modal"
        className="w-full h-[388px] flex flex-col items-center justify-center gap-2"
      >
        <PreLoader size={12} />
        <p className="text-zinc-400 light:text-slate-500 text-sm">
          {t("chat_window.workspace_llm_manager.loading_workspace_settings")}
        </p>
      </div>
    );
  }

  return (
    <div
      id="llm-selector-modal"
      className="w-fit max-w-full h-[388px] p-[18px] flex flex-col"
    >
      <select
        id="workspace-llm-model-select"
        aria-label={t("chat_window.select_model")}
        required={true}
        disabled={modelsLoading || availableModels.length === 0}
        value={
          selectedLLMProvider &&
          selectedLLMModel &&
          availableModels.some(
            (option) =>
              option.provider === selectedLLMProvider &&
              option.model === String(selectedLLMModel)
          )
            ? JSON.stringify([selectedLLMProvider, selectedLLMModel])
            : ""
        }
        onChange={(e) => handleModelSelection(e.target.value)}
        className="bg-zinc-900 light:bg-white text-white light:text-slate-900 text-sm rounded-lg h-9 w-max max-w-full px-2.5 outline-none border border-zinc-700 light:border-slate-400 cursor-pointer"
      >
        <option value="" disabled={true}>
          {modelsLoading
            ? "-- waiting for models --"
            : availableModels.length === 0
              ? "-- no available models --"
              : "-- select a model --"}
        </option>
        {availableModels.map((option) => (
          <option
            key={JSON.stringify([option.provider, option.model])}
            value={JSON.stringify([option.provider, option.model])}
          >
            {option.label} ({option.providerName})
          </option>
        ))}
      </select>
      {missingCredentials && availableModels.length === 0 && (
        <NoSetupWarning
          showing={true}
          onSetupClick={() => {
            window.dispatchEvent(
              new CustomEvent(PROVIDER_SETUP_EVENT, {
                detail: {
                  provider: WORKSPACE_LLM_PROVIDERS.find(
                    (p) => p.value === selectedLLMProvider
                  ),
                  settings,
                },
              })
            );
          }}
        />
      )}
      <div className="mt-auto">
        {hasChanges && !missingCredentials && (
          <button
            type="button"
            disabled={saving}
            onClick={handleSave}
            className="border-none text-xs px-4 py-1.5 font-semibold rounded-lg bg-white text-zinc-900 hover:bg-zinc-200 light:bg-slate-800 light:text-white light:hover:bg-slate-700 h-8 w-full cursor-pointer transition-colors mt-auto"
          >
            {saving
              ? t("chat_window.workspace_llm_manager.saving")
              : t("chat_window.workspace_llm_manager.save")}
          </button>
        )}
      </div>
    </div>
  );
}
