import React, { useState } from "react";
import { Search, ChevronDown } from "lucide-react";
import type { CatalogModel } from "../api";

export function ModelPicker({
  models,
  value,
  onChange,
  placeholder,
}: {
  placeholder?: string;
  models: CatalogModel[];
  value: string;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const pickerId = React.useId();
  const normalized = models
    .map((model) => ({
      model,
      id: model.providerID
        ? `${model.providerID}/${model.id}`
        : String(model.id ?? model.name ?? ""),
      provider: String(model.providerID ?? model.provider ?? ""),
      variants: (Array.isArray(model.variants) ? model.variants : [])
        .map((variant) => {
          if (typeof variant === "string") return { id: variant, name: variant };
          if (!variant || typeof variant !== "object") return null;
          const id = String((variant as { id?: unknown }).id ?? "");
          return id ? { id, name: String((variant as { name?: unknown }).name ?? id) } : null;
        })
        .filter((variant): variant is { id: string; name: string } => Boolean(variant)),
    }))
    .filter((item) => item.id);
  const selectedHash = value.indexOf("#");
  const selectedModel = selectedHash < 0 ? value : value.slice(0, selectedHash);
  const filtered = normalized.filter((item) =>
    `${item.id} ${item.provider} ${item.variants.map((variant) => `${variant.id} ${variant.name}`).join(" ")}`.toLowerCase().includes(query.toLowerCase()),
  );
  const priceTier = (model: CatalogModel) => {
    const raw = JSON.stringify(model.cost ?? model.pricing ?? "").toLowerCase();
    if (!raw || raw === '""' || raw === "null" || raw === "false")
      return "unknown";
    const numbers = [
      ...raw.matchAll(
        /(?:input|output|prompt|completion)[^0-9]*([0-9]+(?:\.[0-9]+)?)/g,
      ),
    ].map((match) => Number(match[1]));
    if (numbers.length >= 2 && numbers.every((number) => number === 0))
      return "free";
    if (numbers.some((number) => number > 0)) return "paid";
    return "unknown";
  };
  return (
    <div className="model-picker">
      <div className="model-picker-input">
        <Search size={14} />
        <input
          id={pickerId}
          aria-label="Model"
          role="combobox"
          aria-expanded={open}
          aria-controls={`${pickerId}-options`}
          value={open ? query : value}
          title={value}
          onFocus={() => {
            setQuery("");
            setOpen(true);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              setOpen(false);
              e.currentTarget.blur();
            }
          }}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          onChange={(event) => {
            setQuery(event.target.value);
          }}
          placeholder={placeholder ?? (models.length ? "Search live models…" : "provider/model")}
        />
        <button
          type="button"
          className="icon-btn"
          aria-label="Toggle model options"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            setQuery("");
            setOpen((value) => !value);
          }}
        >
          <ChevronDown size={14} />
        </button>
      </div>
      {open && models.length > 0 && (
        <div
          className="model-options"
          id={`${pickerId}-options`}
          role="listbox"
        >
          {(["free", "paid", "unknown"] as const).map((tier) => {
            const group = filtered.filter(
              (item) => priceTier(item.model) === tier,
            );
            return group.length ? (
              <div key={tier}>
                <div className="model-group-label">
                  {tier === "paid"
                    ? "Paid"
                    : tier === "free"
                      ? "Free / included"
                      : "Pricing unavailable"}
                </div>
                {group.map((item) => (
                  <div key={item.id} className="model-choice">
                    <button
                      type="button"
                      role="option"
                      aria-selected={selectedModel === item.id}
                      className="model-option"
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => {
                        onChange(item.id);
                        setQuery(item.id);
                        setOpen(false);
                      }}
                    >
                      <span className="model-option-name" title={item.id}>{String(item.model.name || item.id.replace(`${item.provider}/`, ""))}</span>
                      <small>{item.provider || "catalog"}</small>
                    </button>
                    {item.variants.length > 0 && (
                      <div className="model-variants" aria-label={`Variants for ${item.id}`}>
                        <span className="model-variants-label">Effort</span>
                        <div className="model-variant-options">
                        {item.variants.map((variant) => {
                          const variantValue = `${item.id}#${variant.id}`;
                          return (
                            <button
                              type="button"
                              key={variant.id}
                              className="model-variant"
                              aria-pressed={value === variantValue}
                              onMouseDown={(event) => event.preventDefault()}
                              onClick={() => {
                                onChange(variantValue);
                                setQuery(variantValue);
                                setOpen(false);
                              }}
                            >
                              {variant.name.charAt(0).toUpperCase() + variant.name.slice(1)}
                            </button>
                          );
                        })}
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            ) : null;
          })}
          {!filtered.length && (
            <div className="model-empty">No live models match.</div>
          )}
        </div>
      )}
    </div>
  );
}
