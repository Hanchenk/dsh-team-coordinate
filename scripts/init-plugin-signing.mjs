import fs from "node:fs/promises";
import { generateKeyPairSync,createPublicKey } from "node:crypto";
await fs.mkdir(".plugin-signing",{recursive:true,mode:0o700});
const file=".plugin-signing/private.pem";
try{await fs.access(file);}catch{const {privateKey}=generateKeyPairSync("ed25519");await fs.writeFile(file,privateKey.export({type:"pkcs8",format:"pem"}),{mode:0o600,flag:"wx"});}
const publicKey=createPublicKey(await fs.readFile(file)).export({type:"spki",format:"pem"});
await fs.writeFile("packages/dsh-plugin-team-hub/src/release-key.json",JSON.stringify({publicKey},null,2)+"\n");
console.log("Release signing key ready; only the public key is included in the plugin.");
