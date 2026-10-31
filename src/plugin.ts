import streamDeck from "@elgato/streamdeck";

import { RunAction } from "./actions/run";
import { TimerAction } from "./actions/timer";
import { OnceAction } from "./actions/once";

streamDeck.logger.setLevel("info");

streamDeck.actions.registerAction(new RunAction());
streamDeck.actions.registerAction(new TimerAction());
streamDeck.actions.registerAction(new OnceAction());

void streamDeck.connect();
