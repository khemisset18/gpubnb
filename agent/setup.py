"""
Setup configuration for GPUbnb Agent package.
Enables: pip install -e agent
"""

from setuptools import setup, find_packages

setup(
    name='gpubnb-agent',
    version='0.5.0',
    description='GPU Marketplace Agent for Solana',
    author='GPUbnb Team',
    url='https://github.com/khemisset18/gpubnb',
    packages=find_packages(),
    python_requires='>=3.10',
    install_requires=[
        'pynacl==1.5.0',
        'base58==2.1.1',
        'requests>=2.28.0',
        'psutil>=5.9.0',
    ],
    extras_require={
        'dev': [
            'pytest>=7.0',
            'pytest-cov>=3.0',
            'black>=22.0',
            'flake8>=4.0',
            'mypy>=0.950',
        ],
    },
    entry_points={
        'console_scripts': [
            'gpubnb-agent=agent.src.cli:main',
        ],
    },
    classifiers=[
        'Development Status :: 3 - Alpha',
        'Intended Audience :: Developers',
        'License :: OSI Approved :: Apache Software License',
        'Programming Language :: Python :: 3',
        'Programming Language :: Python :: 3.10',
        'Programming Language :: Python :: 3.11',
        'Programming Language :: Python :: 3.12',
    ],
)
