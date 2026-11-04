import "../preload/index";

/*
 * The few things a browser does differently from the desktop window: it opens
 * links itself, and there is no native folder dialog, Finder or log file to
 * show. The folder picker falls back to its own browser when this says null.
 */
const api = window.opendesktop;

api.host.openExternal = async (url: string): Promise<void> => {
  if (/^https?:\/\//i.test(url)) window.open(url, "_blank", "noopener,noreferrer");
};
api.host.pickFolder = async (): Promise<string | null> => null;
api.host.revealLog = async (): Promise<void> => undefined;
