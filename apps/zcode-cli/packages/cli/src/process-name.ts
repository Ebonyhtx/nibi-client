export const CLI_COMMAND_NAME = "nibi";
export const CLI_PROCESS_NAME = "nibi-cli";

interface ProcessTitleTarget {
  title: string;
}

export const setCliProcessTitle = (
  target: ProcessTitleTarget = process,
): void => {
  target.title = CLI_PROCESS_NAME;
};
