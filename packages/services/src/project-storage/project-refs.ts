/** Task 行引用的最小身份；放在独立文件，避免契约文件之间形成类型循环。 */
export interface ProjectTaskRef {
  workspacePath: string;
  workspaceIdentity?: string;
  taskId: string;
}