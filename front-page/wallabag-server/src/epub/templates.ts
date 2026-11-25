export const defaultCss = `
body {
  font-family: serif;
  line-height: 1.6;
  margin: 1em;
}

h1, h2, h3, h4, h5, h6 {
  margin-top: 1.4em;
  margin-bottom: 0.6em;
  line-height: 1.2;
}

h1 { font-size: 1.6em; }
h2 { font-size: 1.4em; }
h3 { font-size: 1.2em; }

p {
  margin: 0.8em 0;
}

code {
  font-family: monospace;
  background: #f0f0f0;
  padding: 0.1em 0.3em;
}

pre {
  background: #f0f0f0;
  padding: 0.8em;
  overflow-x: auto;
  line-height: 1.4;
}

pre code {
  background: none;
  padding: 0;
}

blockquote {
  border-left: 3px solid #ccc;
  margin-left: 0;
  padding-left: 1em;
  color: #555;
}

img {
  max-width: 100%;
  height: auto;
}

ul, ol {
  padding-left: 1.5em;
}

li {
  margin: 0.3em 0;
}
`;
