import * as React from "react";
import { Check, Minus } from "lucide-react";
import { Checkbox as CheckboxPrimitive } from "radix-ui";
import { cn } from "../lib/utils.js";

type CheckboxProps = React.ComponentProps<typeof CheckboxPrimitive.Root> & {
  checkIconStrokeWidth?: number;
};

function Checkbox({ className, checkIconStrokeWidth, ...props }: CheckboxProps) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={cn(
        "peer size-4 shrink-0 rounded-sm border border-input-border bg-input text-primary-foreground shadow-[var(--nibi-shadow-input-inset)] outline-none transition-[background-color,border-color,box-shadow] duration-150 ease-out hover:border-input-border-hover focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:border-primary data-[state=checked]:bg-primary data-[state=checked]:shadow-[var(--nibi-shadow-primary-btn)] data-[state=indeterminate]:border-primary data-[state=indeterminate]:bg-primary data-[state=indeterminate]:shadow-[var(--nibi-shadow-primary-btn)]",
        className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator
        data-slot="checkbox-indicator"
        className="flex items-center justify-center text-current [&[data-state=indeterminate]_[data-slot=checkbox-checked-icon]]:hidden [&[data-state=indeterminate]_[data-slot=checkbox-indeterminate-icon]]:block"
      >
        <Check
          data-slot="checkbox-checked-icon"
          className={cn(
            "size-3",
            checkIconStrokeWidth !== undefined && "[&_path]:[vector-effect:non-scaling-stroke]",
          )}
          strokeWidth={checkIconStrokeWidth}
        />
        <Minus
          data-slot="checkbox-indeterminate-icon"
          className={cn(
            "hidden size-3",
            checkIconStrokeWidth !== undefined && "[&_path]:[vector-effect:non-scaling-stroke]",
          )}
          strokeWidth={checkIconStrokeWidth}
        />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}

export { Checkbox };
