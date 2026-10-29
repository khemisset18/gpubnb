"""Short real CUDA + PEFT LoRA training proof. Run only on an assigned GPU."""
from pathlib import Path
import torch
from peft import LoraConfig, TaskType, get_peft_model
from transformers import BertConfig, BertForSequenceClassification

if not torch.cuda.is_available():
    raise SystemExit("cuda_required_no_cpu_fallback")
model = BertForSequenceClassification(
    BertConfig(vocab_size=128, hidden_size=32, num_hidden_layers=1,
               num_attention_heads=2, intermediate_size=64, num_labels=2)
)
model = get_peft_model(
    model, LoraConfig(r=2, lora_alpha=4, target_modules=["query", "value"],
                      task_type=TaskType.SEQ_CLS)
).cuda()
optimizer = torch.optim.AdamW(model.parameters(), lr=1e-3)
inputs = torch.randint(0, 128, (2, 8), device="cuda")
labels = torch.tensor([0, 1], device="cuda")
loss = model(input_ids=inputs, labels=labels).loss
loss.backward()
optimizer.step()
torch.cuda.synchronize()
out = Path("/workspace/output/lora-smoke")
out.mkdir(parents=True, exist_ok=True)
model.save_pretrained(str(out))
if not any(out.glob("adapter_model.*")):
    raise SystemExit("lora_adapter_not_saved")
print("gpubnb_training_cuda_lora_ok", float(loss.detach().cpu()))
