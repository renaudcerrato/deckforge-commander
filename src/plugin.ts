import streamDeck from "@elgato/streamdeck";

import { RunAction } from "./actions/run";
import { TimerAction } from "./actions/timer";
import { OnceAction } from "./actions/once";
import { receiveScriptImport } from "./actions/program-runtime";

streamDeck.logger.setLevel("info");

streamDeck.actions.registerAction(new RunAction());
streamDeck.actions.registerAction(new TimerAction());
streamDeck.actions.registerAction(new OnceAction());

streamDeck.system.onDidReceiveDeepLink(ev => {
	void receiveScriptImport(ev.url.path, ev.url.queryParameters, ev.url.href.length);
});

void streamDeck.connect();
