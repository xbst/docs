from markdown import Extension
from markdown.treeprocessors import Treeprocessor


class PdfTreeprocessor(Treeprocessor):
    def run(self, root):
        for img in root.iter("img"):
            if img.get("type") == "application/pdf" and img.get("src"):
                img.tag = "embed"


class PdfExtension(Extension):
    def extendMarkdown(self, md):
        md.treeprocessors.register(PdfTreeprocessor(md), "pdf_embed", 1)


def makeExtension(**kwargs):
    return PdfExtension(**kwargs)
