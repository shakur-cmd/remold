import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";

// Every record gets a three-word code like "brisk-otter-lamp": easy to say,
// easy to paste into a prompt, unique per org. 240 words give 13.8 million codes.
const WORDS = (
  "acorn amber anchor apple arrow aspen atlas badge bamboo basil beacon berry birch bison blossom bolt bramble brass breeze brick " +
  "bridge brisk bronze brook cabin cactus candle canyon carbon cedar chalk cherry cider cinder clay cliff clover cobalt comet copper " +
  "coral cotton crane creek crystal cumin daisy dawn delta denim dune dusk eagle ember falcon fern fig flint forest fossil " +
  "frost galaxy garnet ginger glacier granite grove harbor hazel heron hickory honey ivory jade jasper juniper kelp kite lagoon lantern " +
  "lava lemon lilac linen lotus lumen maple marble meadow mesa mint mist moss nectar nickel north oak ocean olive onyx " +
  "orbit orchid otter oyster paper pebble pepper pine plum poppy prism quartz quill rain raven reef ridge river robin rocket " +
  "rose rustic saffron sage salt sand sapphire satin sequoia shade silver sky slate smoke snow solar sparrow spruce steel stone " +
  "storm summit sunny swift tango teal tide timber topaz torch trail tulip tundra umber valley velvet violet walnut willow wren " +
  "yarrow zephyr zinc alpine bold calm clear crisp deep eager fair fond glad grand happy jolly keen kind light lucky merry " +
  "mild noble plain proud quick quiet rapid ready royal sharp shy sleek smart soft solid sound spry steady still sure tidy " +
  "tiny true vivid warm wise witty young zesty brave civil dandy early fresh gentle humble lively lofty lunar mellow modest neat"
).split(/\s+/);

const pick = () => WORDS[Math.floor(Math.random() * WORDS.length)]!;

export async function uniqueRef(ctx: MutationCtx, orgId: Id<"orgs">) {
  for (;;) {
    const ref = `${pick()}-${pick()}-${pick()}`;
    const taken = await ctx.db.query("records").withIndex("by_org_ref", (q) => q.eq("orgId", orgId).eq("ref", ref)).unique();
    if (!taken) return ref;
  }
}

export const isRef = (value: string) => /^[a-z]+-[a-z]+-[a-z]+$/.test(value);
