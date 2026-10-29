//! Bounded, offline, native GLib VariantStrIter regression (no GUI/network).
use glib::variant::ToVariant;
extern "C" { static glib_major_version:u32; static glib_minor_version:u32; static glib_micro_version:u32; }
fn main(){
 let cases=[vec![],vec![""],vec!["one","two","three"],vec!["é","中文","🦀","last"]];
 let mut comparisons=0;
 for _ in 0..256 {
 for expected in &cases {
  let variant=expected.to_variant();
  let mut iter=variant.array_iter_str().unwrap();assert_eq!(iter.len(),expected.len());
  assert_eq!(iter.by_ref().collect::<Vec<_>>(),*expected);assert_eq!(iter.next(),None);comparisons+=1;
  let reversed=variant.array_iter_str().unwrap().rev().collect::<Vec<_>>();assert_eq!(reversed,expected.iter().copied().rev().collect::<Vec<_>>());comparisons+=1;
  let mut mixed=variant.array_iter_str().unwrap();let mut values=vec![];
  if let Some(x)=mixed.next(){values.push(x);}
  if let Some(x)=mixed.next_back(){values.push(x);}
  values.extend(mixed);assert_eq!(values.len(),expected.len());comparisons+=1;
 }
 }
 let wrong=17u64.to_variant();assert!(wrong.array_iter_str().is_err());
 println!("GLIB_VARIANT_STR_ITER_PASS comparisons={comparisons} wrong_type_rejected=true runtime={}.{}.{}",unsafe{glib_major_version},unsafe{glib_minor_version},unsafe{glib_micro_version});
}
