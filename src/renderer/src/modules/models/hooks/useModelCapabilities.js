import { useEffect, useState } from "react";
import { fetchModelCapabilities } from "../api/modelApi.js";

const emptyCapabilities = {
  provider: null,
  source: "provider_default",
  reasoningEfforts: [],
};

export function useModelCapabilities(config, model = config?.model) {
  const [capabilities, setCapabilities] = useState(emptyCapabilities);
  const baseUrl = String(config?.base_url || "").trim();
  const modelId = String(model || "").trim();
  const apiFormat = String(config?.api_format || "");

  useEffect(() => {
    let current = true;
    if (!baseUrl || !modelId || !apiFormat) {
      setCapabilities(emptyCapabilities);
      return () => { current = false; };
    }
    fetchModelCapabilities(config, modelId)
      .then((value) => { if (current) setCapabilities(value); })
      .catch(() => { if (current) setCapabilities(emptyCapabilities); });
    return () => { current = false; };
  }, [baseUrl, modelId, apiFormat]);

  return capabilities;
}
