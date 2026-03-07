// Run this locally to get Twitter cookies, then set them as TWITTER_COOKIES env var on Railway
const { Scraper } = require("@the-convocation/twitter-scraper");

async function main() {
  const username = process.env.TWITTER_USERNAME;
  const password = process.env.TWITTER_PASSWORD;
  const email = process.env.TWITTER_EMAIL;

  if (!username || !password) {
    console.error("Set TWITTER_USERNAME and TWITTER_PASSWORD env vars first");
    process.exit(1);
  }

  const scraper = new Scraper();
  console.log(`Logging in as @${username}...`);

  try {
    await scraper.login(username, password, email);
  } catch (err) {
    console.error("Login failed:", err.message);
    process.exit(1);
  }

  const loggedIn = await scraper.isLoggedIn();
  if (!loggedIn) {
    console.error("Login failed — not authenticated");
    process.exit(1);
  }

  console.log("Login successful!");

  const cookies = await scraper.getCookies();
  const cookieStrings = cookies.map(c => c.toString());
  const encoded = JSON.stringify(cookieStrings);

  console.log("\n=== Copy everything below this line and set as TWITTER_COOKIES on Railway ===\n");
  console.log(encoded);
  console.log("\n=== End ===");
}

main();
