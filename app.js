import { loadState } from "./app/api.js";
import { elements, showToast } from "./app/dom.js";
import { bindEvents } from "./app/events.js";
import { loadThemePreference } from "./app/state.js";

bindEvents();
loadThemePreference();

loadState({ preserveView: false }).catch((error) => {
  elements.toast.hidden = false;
  showToast(error.message);
});
