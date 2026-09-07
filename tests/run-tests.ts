import { finish } from "./common";
import { testHistory } from "./history.test";
import { testOps } from "./ops.test";
import { testMove } from "./move.test";

console.log("--- history ---");
testHistory();
console.log("--- ops ---");
testOps();
console.log("--- move ---");
testMove();
finish();