import type { DatasetRef } from "@data-agent/contracts";
import type { BusinessContext, DisclosureItem, PhysicalProfile } from "../answering/public.js";
import type { ArtifactDirectory } from "./artifact-directory.js";
import type { DerivedDatasets, DerivedInput } from "./derived-datasets.js";

/** Where a chart's rows came from, as delivered charts record and show it. */
export type ChartDataSource =
  /** `live` marks a published result the app may refresh (ADR-0010); every delivery still reads one Receipt. */
  | { readonly kind: "publication"; readonly receiptId: string; readonly contentHash: string; readonly live?: true; readonly publishedAt?: string }
  | { readonly kind: "derived"; readonly derivedId: string; readonly name: string; readonly contentHash: string; readonly inputs: readonly DerivedInput[]; readonly scriptSha256: string };

export interface ResolvedChartData {
  readonly columns: readonly string[];
  readonly rows: readonly (readonly unknown[])[];
  readonly source: ChartDataSource;
  readonly physicalProfile?: PhysicalProfile;
  /** Disclosure summaries of the published results behind the rows; a derived dataset carries its inputs'. */
  readonly disclosures: readonly string[];
  /** The same disclosures, structured, for readers that show them beside the clause they concern. */
  readonly disclosureItems: readonly DisclosureItem[];
}

export interface ChartDataResolverOptions {
  readonly publications: Pick<ArtifactDirectory, "resolveRows" | "resolveReceipt">;
  readonly derived?: Pick<DerivedDatasets, "resolve">;
}

/** Resolves a chart's Dataset Reference through the Runtime and checks it may be delivered (ADR-0008 decision 4). */
export class ChartDataResolver {
  constructor(private readonly options: ChartDataResolverOptions) {}

  async resolve(ref: DatasetRef, context: BusinessContext): Promise<ResolvedChartData> {
    if (ref.kind === "publication" || ref.kind === "live") {
      const published = await this.options.publications.resolveRows(ref.receiptId, context);
      const disclosure = published.receipt.disclosure?.summary;
      return {
        columns: published.columns,
        rows: published.rows,
        source: { kind: "publication", receiptId: ref.receiptId, contentHash: published.receipt.contentHash, ...(ref.kind === "live" ? { live: true as const, publishedAt: published.receipt.createdAt } : {}) },
        ...(published.receipt.physicalProfile ? { physicalProfile: published.receipt.physicalProfile } : {}),
        disclosures: disclosure ? [disclosure] : [],
        disclosureItems: published.receipt.disclosure?.items ?? [],
      };
    }
    if (!this.options.derived) throw new Error("DERIVED_DATASET_UNAVAILABLE: this host does not keep derived datasets");
    const record = await this.options.derived.resolve(ref.derivedId, context);
    // The inputs must still be readable here; their Disclosures travel with the derived rows.
    const disclosures: string[] = [];
    const disclosureItems: DisclosureItem[] = [];
    for (const input of record.provenance.inputs) {
      const receipt = await this.options.publications.resolveReceipt(input.receiptId, context);
      if (receipt.disclosure?.summary) disclosures.push(receipt.disclosure.summary);
      disclosureItems.push(...(receipt.disclosure?.items ?? []));
    }
    return {
      columns: record.columns,
      rows: record.rows,
      source: { kind: "derived", derivedId: record.derivedId, name: record.name, contentHash: record.contentHash, inputs: record.provenance.inputs, scriptSha256: record.provenance.scriptSha256 },
      physicalProfile: record.physicalProfile,
      disclosures,
      disclosureItems,
    };
  }
}

/** One line naming a chart's data source, for tool text, captions and pages. */
export function describeSource(source: ChartDataSource): string {
  if (source.kind === "publication") return source.live ? `实时数据：发布记录 ${source.receiptId}（发布于 ${source.publishedAt ?? "未知时间"}）` : `发布记录 ${source.receiptId}`;
  const inputs = source.inputs.map((input) => input.receiptId).join("、") || "无";
  return `派生数据集 ${source.derivedId}（${source.name}，由脚本 ${source.scriptSha256.slice(0, 12)} 计算，输入：${inputs}）`;
}
