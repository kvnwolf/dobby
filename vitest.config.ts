// Dobby's own suite runs on the BASE preset (this repo has no vite/react): it
// stops discovering the `.claude/**` worktree copies, and it proves the base
// preset loads under vitest with vite NOT installed.
export { default } from "@kvnwolf/dobby/vitest";
