/**
 * Manual Activation prompts (V1: the ONLY activation path).
 *
 * The Driver never spawns or wakes an AI client. `gateflow run` prints a
 * ready-to-copy prompt that tells the user what to paste into ChatGPT /
 * ZCode, so no Issue id, path or mode has to be filled in by hand.
 */

/** Everything the prompt builder needs (all derived from the prepared task). */
export interface PromptInfo {
  taskId: string;
  mode: 'plan' | 'execute';
  issueNumber: number;
  issueTitle: string;
  /** Why this task exists (planning | feedback_applied | approved_plan). */
  reason: string;
}

/** Build the copy-paste prompt for the active AI client. */
export function buildTaskPrompt(info: PromptInfo): string {
  const modeLine =
    info.mode === 'plan'
      ? '本任务是【规划】：阅读真实仓库，产出可执行的执行计划，写入任务目录中的 plan.md。'
      : '本任务是【执行】：严格按照已批准的 plan.md 完成开发与真实验证，完成后写 report.md。';
  return [
    '请使用 gateflow Skill，处理当前工作区的 GateFlow 任务：',
    '',
    `- 任务目录：.gateflow/tasks/${info.taskId}/`,
    `- GitHub Issue：#${info.issueNumber} ${info.issueTitle}`,
    `- 任务来源：${info.reason}`,
    '',
    `1. 读取任务目录中的 task.json 与 task.md。${modeLine}`,
    '2. 只在任务目录内工作：输入文件（task.md、plan.md、feedback.md）不要修改；',
    '   需要了解仓库实现时直接阅读仓库文件。',
    '3. 完成后写 result.json 声明结果（按 task.json 中的 mode 填 status 与 report）。',
    '   不要试图直接修改 GitHub 工作流状态（不发评论、不打标签、不执行命令）。',
    '4. 完成后在终端运行：gateflow sync',
    '',
    '现在开始。',
  ].join('\n');
}
