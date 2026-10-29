//! Public-vector verification only. No secret keys, signing, RPC or RNG usage.
use libsecp256k1::{Message, PublicKey, Signature, verify};
use sha2::{Digest,Sha256};
fn hex(s:&str)->Vec<u8>{assert_eq!(s.len()%2,0);(0..s.len()).step_by(2).map(|i|u8::from_str_radix(&s[i..i+2],16).unwrap()).collect()}
fn main(){
 let path=std::env::args().nth(1).expect("public vector JSON path required");
 let value:serde_json::Value=serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
 let mut count=0;let mut errors=vec![];let mut outcomes=vec![];
 for group in value["testGroups"].as_array().unwrap(){
 let pk=PublicKey::parse_slice(&hex(group["publicKey"]["uncompressed"].as_str().unwrap()),None);
 for case in group["tests"].as_array().unwrap(){
  let hash: [u8;32]=Sha256::digest(hex(case["msg"].as_str().unwrap())).into();
  let msg=Message::parse(&hash);let signature=Signature::parse_der(&hex(case["sig"].as_str().unwrap()));
  let valid=pk.as_ref().ok().zip(signature.as_ref().ok()).is_some_and(|(p,s)|verify(&msg,s,p));
  let expected=case["result"].as_str().unwrap();let id=case["tcId"].as_u64().unwrap();
  if (expected=="valid"&&!valid)||(expected=="invalid"&&valid){errors.push(id);}
  outcomes.push(serde_json::json!({"tcId":id,"expected":expected,"valid":valid}));count+=1;
 }
 }
 let expected=value["numberOfTests"].as_u64().unwrap();assert_eq!(count,expected);
 println!("{}",serde_json::to_string_pretty(&serde_json::json!({"status":if errors.is_empty(){"PASS"}else{"FAIL"},"count":count,"mismatches":errors,"outcomes":outcomes,"operations":["public ECDSA signature verification"]})).unwrap());
 if !errors.is_empty(){std::process::exit(1)}
}
