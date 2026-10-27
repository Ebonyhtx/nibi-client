import type { ModelSelectGroup, ModelSelectGroupItem } from "@/ModelConfigSelect.js";

/** Composer 模型菜单里的一个可切换连接。 */
export interface ComposerConnection {
  key: string;
  label: string;
  providerId: string;
  items: ModelSelectGroupItem[];
  disabled?: boolean;
}

export interface ComposerPlanGroup extends ModelSelectGroup {
  connection?: ComposerConnection;
}

export function chooseConnectionModel(items: readonly ModelSelectGroupItem[], model?: string) {
  return items.find((item) => item.name === model) ?? items[0];
}
