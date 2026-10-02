// Vite's `?raw` import: the file's text as a string (the board frame runtime is
// loaded this way, see components/board/TaskBoardPane.tsx).
declare module '*?raw' {
  const content: string;
  export default content;
}
