from pathlib import Path

path = Path("services/edge/src/bin/gpubnb-edge.rs")
text = path.read_text(encoding="utf-8")
old = '''            renter_send
                .finish()
                .context("failed to finish renter response stream")?;
            Result::<u64>::Ok(bytes)
'''
new = '''            renter_send
                .finish()
                .context("failed to finish renter response stream")?;
            match renter_send
                .stopped()
                .await
                .context("failed while waiting for renter response acknowledgement")?
            {
                None => {}
                Some(code) => {
                    bail!("renter stopped response stream before acknowledging FIN: {code}")
                }
            }
            Result::<u64>::Ok(bytes)
'''
count = text.count(old)
if count != 1:
    raise SystemExit(f"expected exactly one renter FIN anchor, found {count}")
path.write_text(text.replace(old, new, 1), encoding="utf-8")
