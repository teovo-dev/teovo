// With `npm run dev` running: fetch /check and print the result.
const res = await fetch('http://localhost:8790/check')
console.log(JSON.stringify(await res.json(), null, 2))
