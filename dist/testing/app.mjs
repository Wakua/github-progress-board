import { mountCaseEditor } from './case-view.mjs';
import { createCaseRepository } from './repository.mjs';
mountCaseEditor(document.querySelector('main'), { repository: createCaseRepository() });
